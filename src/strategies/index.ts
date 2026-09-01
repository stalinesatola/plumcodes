import type { Strategy, StrategyContext, TradeIntent, Candle } from "../types.ts";
import { sma, ema, rsi } from "../util/indicators.ts";

// ============================================================================
// RESET 2026-08-30 — foco em Gold/USD (frxXAUUSD), mercado real.
// Estrategias antigas (sinteticos) arquivadas em `_archive_synthetics.ts.txt`.
//
// Caracterizacao do frxXAUUSD (200k candles M1, ~145 dias de pregao, tools/gold-characterize.ts):
//   - autocorrelacao ~0 em M1/M5 (acf1 -0.003 / +0.006); leve reversao em M15 (acf1 -0.022, VR(8)=0.93)
//   - vol por hora UTC bem marcada: pico 12h-15h (overlap Londres/NY), range M1 mediano
//     ~$3.0 vs ~$1.1 nas horas mortas (04h, 20h)
//   - sessao de Londres (07-12 UTC) e a mais mean-revert (M5 VR(4)=0.90)
//   - ATR: M1 ~$2.5, M5 ~$6, M15 ~$11 (preco ~$4436, pip 0.01)
// Contrato: MULTIPLIER MULTUP/MULTDOWN (SL/TP em USD, sem expiry). Comissao ~0.00014*mult
// do nocional por round-trip -> modelada como custo em R no backtester (tools/_sim.ts).
// ============================================================================

// -------- helpers --------

/** Reamostra M1 -> periodo (segundos), mantendo TODOS os buckets (o ultimo pode estar
 *  incompleto — tratado como "barra corrente", igual a um grafico ao vivo). */
function rs(cs: Candle[], periodSec: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of cs) {
    const b = Math.floor(c.epoch / periodSec) * periodSec;
    if (!cur || cur.epoch !== b) {
      if (cur) out.push(cur);
      cur = { epoch: b, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function atr(cs: Candle[], period: number): number | null {
  if (cs.length < period + 1) return null;
  let s = 0;
  for (let i = cs.length - period; i < cs.length; i++) {
    const c = cs[i]!, p = cs[i - 1]!;
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return s / period;
}

const hourUTC = (epoch: number) => new Date(epoch * 1000).getUTCHours();
/** hora `h` está na janela [start,end)? Suporta janela que cruza a meia-noite
 *  (ex.: Sydney 21→06). */
const inWin = (h: number, start: number, end: number) =>
  start <= end ? h >= start && h < end : h >= start || h < end;

// ============================================================================
// 1) gold_session_breakout — rompimento de canal Donchian M15, filtrado por sessao.
//    Hipotese: nas horas liquidas (08-19 UTC, com pico no overlap Londres/NY) uma
//    quebra do range das ultimas `chanLen` velas M15 inicia uma expansao de
//    volatilidade direcional. Stop = atrMult*ATR(M15), alvo = rr*stop.
// ============================================================================
const goldSessionBreakout: Strategy = {
  name: "gold_session_breakout",
  warmup: 60,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const tradeStart = p.tradeStart ?? 8, tradeEnd = p.tradeEnd ?? 19;
    const mult = p.multiplier ?? 100;
    const rr = p.rr ?? 2;
    const chanLen = Math.round(p.chanLen ?? 16); // nr de velas M15 do canal (16 = 4h)
    const buffFrac = p.bufferFrac ?? 0.0002;
    const atrMult = p.atrMult ?? 1.2;
    const maxStopPct = p.maxStopPct ?? 0.004;

    const m1 = ctx.candles;
    if (m1.length < 90) return null;
    const last = m1[m1.length - 1]!;
    const h = hourUTC(last.epoch);
    if (!inWin(h, tradeStart, tradeEnd)) return null;

    // canal Donchian em M15 (barras fechadas)
    const m15 = rs(m1, 900).slice(0, -1);
    if (m15.length < chanLen + 15) return null;
    const win = m15.slice(-1 - chanLen, -1); // exclui a barra M15 recem-fechada
    const hi = Math.max(...win.map((c) => c.high));
    const lo = Math.min(...win.map((c) => c.low));
    const a = atr(m15.slice(-30), 14);
    if (a == null || a <= 0) return null;
    const buf = last.close * buffFrac;
    const cur = m15[m15.length - 1]!; // barra M15 recem-fechada
    const prevM15 = m15[m15.length - 2]!;

    // rompimento: a M15 recem-fechada fecha alem do canal e a anterior estava dentro
    const brokeUp = cur.close > hi + buf && prevM15.close <= hi + buf;
    const brokeDn = cur.close < lo - buf && prevM15.close >= lo - buf;
    if (!brokeUp && !brokeDn) return null;

    if (brokeUp) {
      let stopDistance = atrMult * a;
      if (stopDistance / last.close > maxStopPct) stopDistance = maxStopPct * last.close;
      return { contractType: "MULTUP", durationTicks: 0, tag: "brk_up", multiplier: mult, stopDistance, rr };
    }
    let stopDistance = atrMult * a;
    if (stopDistance / last.close > maxStopPct) stopDistance = maxStopPct * last.close;
    return { contractType: "MULTDOWN", durationTicks: 0, tag: "brk_dn", multiplier: mult, stopDistance, rr };
  },
};

// ============================================================================
// 2) gold_trend_m15 — seguimento de tendencia em M15.
//    Hipotese: apesar da autocorrelacao ~0, movimentos macro do ouro geram
//    tendencias multi-hora; entrar na direcao da EMA rapida vs lenta com
//    inclinacao a favor, so nas horas liquidas (11-20 UTC). Stop ATR, alvo rr.
// ============================================================================
const goldTrendM15: Strategy = {
  name: "gold_trend_m15",
  warmup: 60,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const fastP = Math.round(p.fast ?? 9);
    const slowP = Math.round(p.slow ?? 21);
    const slopeLb = Math.round(p.slopeLookback ?? 3);
    const mult = p.multiplier ?? 100;
    const rr = p.rr ?? 2;
    const atrMult = p.atrMult ?? 1.2;
    const hStart = p.tradeStart ?? 11, hEnd = p.tradeEnd ?? 20;
    const pullbackFrac = p.pullbackFrac ?? 0.0006; // preco deve estar perto da EMA rapida

    const m1 = ctx.candles;
    const m15 = rs(m1, 900);
    if (m15.length < slowP + slopeLb + 20) return null;
    // usa apenas barras FECHADAS: descarta a ultima (corrente)
    const closed = m15.slice(0, -1);
    const last = closed[closed.length - 1]!;
    const h = hourUTC(m1[m1.length - 1]!.epoch);
    if (!inWin(h, hStart, hEnd)) return null;

    const cl = closed.map((c) => c.close);
    const f = ema(cl, fastP);
    const s = ema(cl, slowP);
    const fPast = ema(cl.slice(0, -slopeLb), fastP);
    if (f == null || s == null || fPast == null) return null;
    const a = atr(closed, 14);
    if (a == null) return null;

    const slopeUp = f > fPast;
    const price = last.close;
    const nearFast = Math.abs(price - f) <= pullbackFrac * price;

    // LONG: EMA rapida > lenta, inclinacao p/ cima, preco recuou ate a EMA rapida
    if (f > s && slopeUp && nearFast && price > s) {
      const stopDistance = atrMult * a;
      return { contractType: "MULTUP", durationTicks: 0, tag: "trend_up", multiplier: mult, stopDistance, rr };
    }
    if (f < s && !slopeUp && nearFast && price < s) {
      const stopDistance = atrMult * a;
      return { contractType: "MULTDOWN", durationTicks: 0, tag: "trend_dn", multiplier: mult, stopDistance, rr };
    }
    return null;
  },
};

// ============================================================================
// 3) gold_meanrev_london — reversao a media em M5 durante Londres (07-12 UTC),
//    a sessao mais mean-revert (VR(4)=0.90). Fade de extremos de Bollinger + RSI.
//    Stop alem da banda, alvo = banda media (rr baixo, ~1).
// ============================================================================
const goldMeanRevLondon: Strategy = {
  name: "gold_meanrev_london",
  warmup: 60,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const bbP = Math.round(p.bbPeriod ?? 20);
    const bbK = p.bbK ?? 2.2;
    const rsiP = Math.round(p.rsiPeriod ?? 14);
    const rsiOb = p.rsiOb ?? 72, rsiOs = p.rsiOs ?? 28;
    const mult = p.multiplier ?? 100;
    const rr = p.rr ?? 1;
    const stopAtrMult = p.stopAtrMult ?? 1.0;
    const hStart = p.tradeStart ?? 7, hEnd = p.tradeEnd ?? 12;

    const m1 = ctx.candles;
    const m5 = rs(m1, 300);
    if (m5.length < bbP + rsiP + 10) return null;
    const closed = m5.slice(0, -1);
    const last = closed[closed.length - 1]!;
    const h = hourUTC(m1[m1.length - 1]!.epoch);
    if (!inWin(h, hStart, hEnd)) return null;

    const cl = closed.map((c) => c.close);
    const mid = sma(cl, bbP);
    if (mid == null) return null;
    const slice = cl.slice(-bbP);
    const sd = Math.sqrt(slice.reduce((acc, x) => acc + (x - mid) ** 2, 0) / bbP);
    const upper = mid + bbK * sd, lower = mid - bbK * sd;
    const rv = rsi(cl, rsiP);
    if (rv == null) return null;
    const a = atr(closed, 14);
    if (a == null || a <= 0) return null;

    // SHORT: fechou acima da banda superior + RSI sobrecomprado
    if (last.close > upper && rv >= rsiOb) {
      const stopDistance = stopAtrMult * a + (last.close - upper);
      return { contractType: "MULTDOWN", durationTicks: 0, tag: "mr_short", multiplier: mult, stopDistance, rr };
    }
    if (last.close < lower && rv <= rsiOs) {
      const stopDistance = stopAtrMult * a + (lower - last.close);
      return { contractType: "MULTUP", durationTicks: 0, tag: "mr_long", multiplier: mult, stopDistance, rr };
    }
    return null;
  },
};

// ============================================================================
// 4) gold_ny_momo — momentum pos-abertura de NY. Hipotese: o influxo de ordens
//    apos 13:00-13:30 UTC (abertura de NY / dados macro) gera continuacao de
//    curto prazo. Entra na direcao do candle M5 de forca > X*ATR entre 13-15 UTC.
// ============================================================================
const goldNyMomo: Strategy = {
  name: "gold_ny_momo",
  warmup: 60,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const hStart = p.tradeStart ?? 13, hEnd = p.tradeEnd ?? 15;
    const forceMult = p.forceMult ?? 1.3; // corpo do M5 >= forceMult * ATR(M5)
    const mult = p.multiplier ?? 100;
    const rr = p.rr ?? 1.5;
    const stopAtrMult = p.stopAtrMult ?? 1.0;

    const m1 = ctx.candles;
    const m5 = rs(m1, 300);
    if (m5.length < 30) return null;
    const closed = m5.slice(0, -1);
    const last = closed[closed.length - 1]!;
    const h = hourUTC(m1[m1.length - 1]!.epoch);
    if (!inWin(h, hStart, hEnd)) return null;

    const a = atr(closed, 14);
    if (a == null || a <= 0) return null;
    const body = last.close - last.open;
    if (Math.abs(body) < forceMult * a) return null;
    const stopDistance = stopAtrMult * a;
    if (body > 0)
      return { contractType: "MULTUP", durationTicks: 0, tag: "ny_up", multiplier: mult, stopDistance, rr };
    return { contractType: "MULTDOWN", durationTicks: 0, tag: "ny_dn", multiplier: mult, stopDistance, rr };
  },
};

// ============================================================================
// ÍNDICES OTC (Tokyo N225, Sydney AS51, Frankfurt GDAXI) — sem multiplicadores.
// Só CALL/PUT binário, duração mínima 15 min, payout ~+82% → breakeven ~55% de
// acerto. Operam só na janela de sessão do próprio índice (params.tradeStart/End).
// ============================================================================

/** idx_session_momo — momentum M5 na sessão do índice. Candle M5 de força na
 *  direção da EMA rápida vs lenta → CALL/PUT 15 min. */
const idxSessionMomo: Strategy = {
  name: "idx_session_momo",
  warmup: 0,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const hStart = p.tradeStart ?? 0;
    const hEnd = p.tradeEnd ?? 6;
    const emaFast = Math.round(p.emaFast ?? 8);
    const emaSlow = Math.round(p.emaSlow ?? 21);
    const forceMult = p.forceMult ?? 0.9; // corpo M5 >= forceMult * ATR(M5)
    const durMin = Math.round(p.durationMin ?? 15);

    const m1 = ctx.candles;
    const m5 = rs(m1, 300).slice(0, -1);
    if (m5.length < emaSlow + 20) return null;
    const h = hourUTC(m1[m1.length - 1]!.epoch);
    if (!inWin(h, hStart, hEnd)) return null;

    const cl = m5.map((c) => c.close);
    const f = ema(cl, emaFast);
    const s = ema(cl, emaSlow);
    const a = atr(m5, 14);
    if (f == null || s == null || a == null || a <= 0) return null;
    const last = m5[m5.length - 1]!;
    const body = last.close - last.open;

    const up = f > s && last.close > f && body > forceMult * a;
    const dn = f < s && last.close < f && -body > forceMult * a;
    if (up) return { contractType: "CALL", durationTicks: durMin, durationUnit: "m", tag: "idx_up" };
    if (dn) return { contractType: "PUT", durationTicks: durMin, durationUnit: "m", tag: "idx_dn" };
    return null;
  },
};

/** idx_orb — rompimento do range de abertura. Marca high/low dos primeiros
 *  `orbMinutes` da sessão; quando o M5 recém-fechado rompe (vindo de dentro) →
 *  CALL/PUT 15 min na direção do rompimento. */
const idxOrb: Strategy = {
  name: "idx_orb",
  warmup: 0,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const hStart = p.tradeStart ?? 0;
    const hEnd = p.tradeEnd ?? 6;
    const orbMin = Math.round(p.orbMinutes ?? 30);
    const buffFrac = p.bufferFrac ?? 0.0004;
    const durMin = Math.round(p.durationMin ?? 15);

    const m1 = ctx.candles;
    if (m1.length < orbMin + 40) return null;
    const now = m1[m1.length - 1]!;
    const h = hourUTC(now.epoch);
    if (!inWin(h, hStart, hEnd)) return null;

    // início da sessão em epoch (hoje)
    const d = new Date(now.epoch * 1000);
    const sessOpen = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Math.floor(hStart), 0, 0) / 1000);
    const orbEnd = sessOpen + orbMin * 60;
    // só age na 1ª hora após o ORB fechar
    if (now.epoch < orbEnd || now.epoch > orbEnd + 3600) return null;

    const orbBars = m1.filter((c) => c.epoch >= sessOpen && c.epoch < orbEnd);
    if (orbBars.length < orbMin * 0.6) return null;
    const hi = Math.max(...orbBars.map((c) => c.high));
    const lo = Math.min(...orbBars.map((c) => c.low));
    const m5 = rs(m1, 300).slice(0, -1);
    if (m5.length < 3) return null;
    const cur = m5[m5.length - 1]!;
    const prev = m5[m5.length - 2]!;
    const buf = now.close * buffFrac;

    const brokeUp = cur.close > hi + buf && prev.close <= hi + buf;
    const brokeDn = cur.close < lo - buf && prev.close >= lo - buf;
    if (brokeUp) return { contractType: "CALL", durationTicks: durMin, durationUnit: "m", tag: "orb_up" };
    if (brokeDn) return { contractType: "PUT", durationTicks: durMin, durationUnit: "m", tag: "orb_dn" };
    return null;
  },
};

const REGISTRY: Record<string, Strategy> = {};
for (const s of [
  goldSessionBreakout,
  goldTrendM15,
  goldMeanRevLondon,
  goldNyMomo,
  idxSessionMomo,
  idxOrb,
] as Strategy[]) {
  REGISTRY[s.name] = s;
}

export function getStrategy(name: string): Strategy {
  const s = REGISTRY[name];
  if (!s)
    throw new Error(
      `Estrategia desconhecida: "${name}". Disponiveis: ${Object.keys(REGISTRY).join(", ")}`,
    );
  return s;
}

export type { StrategyContext };
