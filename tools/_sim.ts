/** Núcleo de simulação compartilhado por backtest.ts e scan-symbols.ts. */
import { getStrategy } from "../src/strategies/index.ts";
import { resample } from "../src/util/candles.ts";
import { adx } from "../src/util/indicators.ts";
import type { Candle, StrategyContext } from "../src/types.ts";

const CTX_WINDOW = 1050; // ~17.5h de M1 -> cobre sessao asiatica + overlap e resample M15/EMA21
const H1_WINDOW = 15000; // ~10 dias de M1 -> ~250 velas H1 (cobre EMA200 no H1)

function ctxAt(
  candles: Candle[],
  upto: number,
  params: Record<string, number>,
  h1All?: Candle[],
): StrategyContext {
  const closed = candles.slice(Math.max(0, upto - CTX_WINDOW), upto);
  const closes = closed.map((c) => c.close);
  const nowEpoch = closed[closed.length - 1]?.epoch ?? 0;
  // contexto de timeframe alto (H1). Preferir a serie H1 REAL (h1All) quando o
  // caller a passa — a Deriv so serve ~4000 velas M1 de cripto, entao reamostrar
  // M1 nao chega p/ EMA50/200 no H1. Sem h1All, cai no resample de M1 (util p/ o
  // ouro, que tem M1 fundo). `resample`/filter mantem so barras JA FECHADAS.
  let h1: Candle[];
  if (h1All && h1All.length) {
    h1 = h1All.filter((c) => c.epoch + 3600 <= nowEpoch);
  } else {
    h1 = resample(candles.slice(Math.max(0, upto - H1_WINDOW), upto), 3600);
  }
  const m15 = resample(closed, 900);
  const adxM15 = m15.length > 40 ? adx(m15, 14) : null;
  // NOTA: `structure` continua null aqui (era filtro XAUUSD-only, desligado).
  return {
    prices: closes,
    digits: [],
    candles: closed,
    candleClosed: true,
    price: closes[closes.length - 1] ?? 0,
    pipSize: 2,
    params,
    tuning: 0,
    defaultDurationTicks: params.durationTicks ?? 5,
    h1,
    adxM15,
    structure: null,
  };
}

function simulateMult(
  candles: Candle[],
  entryIdx: number,
  dir: "up" | "down",
  entryPrice: number,
  stopDistance: number,
  rr: number,
  maxBars: number,
): { r: number; bars: number } | null {
  const tp = dir === "up" ? entryPrice + rr * stopDistance : entryPrice - rr * stopDistance;
  const sl = dir === "up" ? entryPrice - stopDistance : entryPrice + stopDistance;
  for (let i = entryIdx + 1; i < Math.min(candles.length, entryIdx + 1 + maxBars); i++) {
    const c = candles[i]!;
    const hitSl = dir === "up" ? c.low <= sl : c.high >= sl;
    const hitTp = dir === "up" ? c.high >= tp : c.low <= tp;
    if (hitSl) return { r: -1, bars: i - entryIdx };
    if (hitTp) return { r: rr, bars: i - entryIdx };
  }
  return null;
}

export interface BtMetrics {
  strategy: string;
  trades: number;
  wins: number;
  winrate: number;
  expectancy: number; // R por trade
  rSum: number;
  maxDd: number;
  worstStreak: number;
  breakevenWr: number;
  longs: number;
  shorts: number;
}

export function runBacktest(
  candles: Candle[],
  strategyName: string,
  params: Record<string, number>,
  h1Candles?: Candle[],
): BtMetrics {
  const strat = getStrategy(strategyName);
  const rr = params.rr ?? 2;
  const maxBars = params.maxBars ?? 60;
  // custo por trade (comissao + spread) em unidades de R. Deriv MULTIPLIER cobra
  // comissao ~0.00014*multiplier do nocional por round-trip; convertido p/ R usando
  // R_stake = multiplier * (stopDistance/entry). costR = comissao_stake / R_stake.
  // Passe --param costR=0 p/ ver o resultado BRUTO.
  const costROverride = params.costR;
  let trades = 0;
  let wins = 0;
  let longs = 0;
  let shorts = 0;
  let rSum = 0;
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  let streak = 0;
  let worstStreak = 0;
  let openUntil = -1;

  const step = Math.max(1, Math.round(params.stepBars ?? 1));
  for (let i = strat.warmup + 60; i < candles.length - 1; i++) {
    if (i <= openUntil) continue;
    if (step > 1 && i % step !== 0) continue;
    const intent = strat.evaluate(ctxAt(candles, i + 1, params, h1Candles));
    if (!intent) continue;
    const entry = candles[i]!.close;

    let r: number | null = null;
    let barsUsed = Math.max(1, intent.durationTicks || 5);
    if (intent.contractType === "MULTUP" || intent.contractType === "MULTDOWN") {
      const dir = intent.contractType === "MULTUP" ? "up" : "down";
      const sd = intent.stopDistance ?? entry * 0.001;
      const res = simulateMult(candles, i, dir, entry, sd, intent.rr ?? rr, maxBars);
      if (res !== null) {
        dir === "up" ? longs++ : shorts++;
        barsUsed = res.bars;
        const mult = intent.multiplier ?? params.multiplier ?? 100;
        const rStake = mult * (sd / entry);
        const commStake = 0.00028 * mult; // ~2x o valor observado p/ round-trip + folga de spread
        const costR = costROverride ?? (rStake > 0 ? commStake / rStake : 0.05);
        r = res.r - costR; // desconta custo do resultado (perde -> -1-cost, ganha -> rr-cost)
      }
    } else {
      // CALL/PUT (Rise/Fall). Candles são M1, portanto duração em "m" == nº de candles.
      const dur = Math.max(1, intent.durationTicks || 5);
      const exitIdx = Math.min(candles.length - 1, i + dur);
      barsUsed = dur;
      const exit = candles[exitIdx]!.close;
      const up = exit > entry;
      const win = (intent.contractType === "CALL" && up) || (intent.contractType === "PUT" && !up);
      // payout binário real (índices ~0.81, sintéticos ~0.95). Override: --param payout=0.81
      const payout = params.payout ?? 0.95;
      r = win ? payout : -1;
    }
    if (r === null) continue;

    trades++;
    rSum += r;
    equity += r;
    if (r > 0) {
      wins++;
      streak = 0;
    } else {
      streak++;
      worstStreak = Math.max(worstStreak, streak);
    }
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    openUntil = i + Math.max(1, barsUsed);
  }

  return {
    strategy: strategyName,
    trades,
    wins,
    winrate: trades ? wins / trades : 0,
    expectancy: trades ? rSum / trades : 0,
    rSum,
    maxDd,
    worstStreak,
    breakevenWr: params.payout ? 1 / (1 + params.payout) : 1 / (1 + rr),
    longs,
    shorts,
  };
}
