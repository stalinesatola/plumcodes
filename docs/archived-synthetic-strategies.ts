import type { Strategy, StrategyContext, TradeIntent } from "../types.ts";
import { sma, ema, rsi, momentum, stochastic, lastFractalSwings } from "../util/indicators.ts";

// ---------- Rise/Fall ----------

const maCrossover: Strategy = {
  name: "ma_crossover",
  warmup: 25,
  kind: "riseFall",
  evaluate({ prices, params, defaultDurationTicks }): TradeIntent | null {
    const fast = params.fastPeriod ?? 5;
    const slow = params.slowPeriod ?? 20;
    if (prices.length < slow + 2) return null;
    const prev = prices.slice(0, -1);
    const fNow = sma(prices, fast);
    const sNow = sma(prices, slow);
    const fPrev = sma(prev, fast);
    const sPrev = sma(prev, slow);
    if (fNow == null || sNow == null || fPrev == null || sPrev == null) return null;
    if (fPrev <= sPrev && fNow > sNow)
      return { contractType: "CALL", durationTicks: defaultDurationTicks, tag: "CALL" };
    if (fPrev >= sPrev && fNow < sNow)
      return { contractType: "PUT", durationTicks: defaultDurationTicks, tag: "PUT" };
    return null;
  },
};

const rsiReversion: Strategy = {
  name: "rsi_reversion",
  warmup: 20,
  kind: "riseFall",
  evaluate({ prices, params, tuning, defaultDurationTicks }): TradeIntent | null {
    const period = params.period ?? 14;
    const os = (params.oversold ?? 30) - tuning * 10;
    const ob = (params.overbought ?? 70) + tuning * 10;
    const v = rsi(prices, period);
    if (v == null) return null;
    if (v <= os) return { contractType: "CALL", durationTicks: defaultDurationTicks, tag: "CALL" };
    if (v >= ob) return { contractType: "PUT", durationTicks: defaultDurationTicks, tag: "PUT" };
    return null;
  },
};

const momentumStrat: Strategy = {
  name: "momentum",
  warmup: 15,
  kind: "riseFall",
  evaluate({ prices, params, defaultDurationTicks }): TradeIntent | null {
    const lookback = params.lookback ?? 10;
    const threshold = params.threshold ?? 0;
    const m = momentum(prices, lookback);
    if (m == null) return null;
    if (m > threshold) return { contractType: "CALL", durationTicks: defaultDurationTicks, tag: "CALL" };
    if (m < -threshold) return { contractType: "PUT", durationTicks: defaultDurationTicks, tag: "PUT" };
    return null;
  },
};

// ---------- M1 Scalping (multiplicadores) ----------
// mBOS + EMA50 + Estocastico(14,3,3) em candles M1. Opera MULTUP/MULTDOWN com
// stop no swing M1 e take-profit 1:2. So avalia no FECHAMENTO de cada candle.

const m1Scalp: Strategy = {
  name: "m1_scalp",
  warmup: 0,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;

    const emaPeriod = ctx.params.emaPeriod ?? 50;
    const kPeriod = ctx.params.kPeriod ?? 14;
    const slowing = ctx.params.slowing ?? 3;
    const dPeriod = ctx.params.dPeriod ?? 3;
    const ob = ctx.params.overbought ?? 80;
    const os = ctx.params.oversold ?? 20;
    const swingK = Math.max(1, Math.round(ctx.params.swingK ?? 2));
    const stochLookback = Math.max(2, Math.round(ctx.params.stochLookback ?? 4));
    const multiplier = ctx.params.multiplier ?? 100;
    const rr = ctx.params.rr ?? 2;

    const cs = ctx.candles;
    if (cs.length < emaPeriod + kPeriod + slowing + dPeriod + swingK + 3) return null;

    const closes = cs.map((c) => c.close);
    const highs = cs.map((c) => c.high);
    const lows = cs.map((c) => c.low);

    const emaVal = ema(closes, emaPeriod);
    if (emaVal == null) return null;

    const st = stochastic(highs, lows, closes, kPeriod, slowing, dPeriod);
    if (st.length < stochLookback + 2) return null;
    const cur = st[st.length - 1]!;

    // Estrutura no fechamento (mBOS = rompimento do ultimo topo/fundo local de close).
    const { swingHigh, swingLow } = lastFractalSwings(closes, closes, swingK);
    if (swingHigh == null || swingLow == null) return null;

    const lastClose = closes[closes.length - 1]!;

    // Procura, na janela recente, um cruzamento do estocastico vindo do extremo.
    // (Melhora vs. regra rigida: o cruzamento e o rompimento nao precisam cair
    //  exatamente no mesmo candle — basta o cruzamento ter ocorrido ha poucas barras
    //  e o momento ainda estar a favor.)
    const w = st.slice(-1 - stochLookback);
    let barsSinceCrossUp = -1;
    let barsSinceCrossDown = -1;
    for (let i = 1; i < w.length; i++) {
      const a = w[i - 1]!;
      const b = w[i]!;
      const agoBars = w.length - 1 - i;
      if (a.k <= a.d && b.k > b.d && Math.min(a.k, a.d, b.k) <= os + 10) barsSinceCrossUp = agoBars;
      if (a.k >= a.d && b.k < b.d && Math.max(a.k, a.d, b.k) >= ob - 10) barsSinceCrossDown = agoBars;
    }
    // cruzamento fresco (<=3 barras), momento ainda a favor, sem estar totalmente esticado
    const freshCrossUp = barsSinceCrossUp >= 0 && barsSinceCrossUp <= 3;
    const freshCrossDown = barsSinceCrossDown >= 0 && barsSinceCrossDown <= 3;
    // momento ainda a favor e nao totalmente esticado (deixa espaco ate o extremo)
    const momentumUp = freshCrossUp && cur.k >= cur.d && cur.k < 95;
    const momentumDown = freshCrossDown && cur.k <= cur.d && cur.k > 5;
    const crossedUpFromOs = momentumUp;
    const crossedDownFromOb = momentumDown;

    // LONG: preco > EMA50 + mBOS (rompeu topo local) + estocastico cruzou p/ cima saindo de <=20
    if (lastClose > emaVal && lastClose > swingHigh && crossedUpFromOs && momentumUp) {
      const stopDistance = lastClose - swingLow;
      if (stopDistance <= 0) return null;
      return { contractType: "MULTUP", durationTicks: 0, tag: "MULTUP", multiplier, stopDistance, rr };
    }
    // SHORT: espelho
    if (lastClose < emaVal && lastClose < swingLow && crossedDownFromOb && momentumDown) {
      const stopDistance = swingHigh - lastClose;
      if (stopDistance <= 0) return null;
      return { contractType: "MULTDOWN", durationTicks: 0, tag: "MULTDOWN", multiplier, stopDistance, rr };
    }
    return null;
  },
};

// ---------- M1 AMD (Quebra de Estrutura + Retracao) ----------
// Multi-timeframe: filtro de tendencia no M5 (EMA9/EMA21), gatilho no M1
// (pullback as EMAs + estocastico 5,3,3 saindo do extremo + candle de rejeicao
//  com pavio longo que rompe a maxima/minima do candle anterior).
// Alvo baixo (rr configuravel, default 1.0) para buscar taxa de acerto alta.
// Sem VWAP — indices sinteticos nao tem volume real.

interface OHLC { epoch: number; open: number; high: number; low: number; close: number }

/** Reamostra candles menores em candles de `periodSec` (ex: M1 -> M5). */
function resample(cs: OHLC[], periodSec: number): OHLC[] {
  const out: OHLC[] = [];
  let cur: OHLC | null = null;
  for (const c of cs) {
    const bucket = Math.floor(c.epoch / periodSec) * periodSec;
    if (!cur || cur.epoch !== bucket) {
      if (cur) out.push(cur);
      cur = { epoch: bucket, open: c.open, high: c.high, low: c.low, close: c.close };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
    }
  }
  // nao empurra o bucket corrente (incompleto) — so candles fechados
  return out;
}

const emaPrev = (arr: number[], p: number) => ema(arr.slice(0, -1), p);

const m1Amd: Strategy = {
  name: "m1_amd",
  warmup: 0,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const emaFast = p.emaFast ?? 9;
    const emaSlow = p.emaSlow ?? 21;
    const kP = p.kPeriod ?? 5;
    const kSlow = p.slowing ?? 3;
    const kD = p.dPeriod ?? 3;
    const os = p.oversold ?? 20;
    const ob = p.overbought ?? 80;
    const wickRatio = p.wickRatio ?? 1.0; // pavio a favor >= wickRatio * corpo
    const pullbackTol = p.pullbackTolPct ?? 0.0015; // quao perto da EMA o pullback tem de chegar
    const crossLookback = Math.max(1, Math.round(p.stochLookback ?? 4));
    const maxStopPct = p.maxStopPct ?? 0.006; // stop mais largo que isto -> pula
    const requireBreak = (p.requireBreak ?? 1) > 0; // exigir rompimento da maxima/minima do candio anterior
    const multiplier = p.multiplier ?? 100;
    const rr = p.rr ?? 1.0;

    const m1 = ctx.candles as OHLC[];
    if (m1.length < emaSlow * 3 + 20) return null;

    // --- filtro M5 ---
    const m5 = resample(m1, 300);
    if (m5.length < emaSlow + 3) return null;
    const m5c = m5.map((c) => c.close);
    const m5Fast = ema(m5c, emaFast);
    const m5FastPrev = emaPrev(m5c, emaFast);
    const m5Slow = ema(m5c, emaSlow);
    if (m5Fast == null || m5FastPrev == null || m5Slow == null) return null;
    const m5Bull = m5c[m5c.length - 1]! > m5Slow && m5Fast > m5FastPrev;
    const m5Bear = m5c[m5c.length - 1]! < m5Slow && m5Fast < m5FastPrev;
    if (!m5Bull && !m5Bear) return null;

    // --- M1 ---
    const c = m1.map((x) => x.close);
    const h = m1.map((x) => x.high);
    const l = m1.map((x) => x.low);
    const fast = ema(c, emaFast);
    const slow = ema(c, emaSlow);
    if (fast == null || slow == null) return null;

    const st = stochastic(h, l, c, kP, kSlow, kD);
    if (st.length < crossLookback + 2) return null;
    const cur = st[st.length - 1]!;

    // cruzamento recente do estocastico vindo do extremo
    let crossUpAgo = -1;
    let crossDnAgo = -1;
    const wnd = st.slice(-1 - crossLookback);
    for (let i = 1; i < wnd.length; i++) {
      const a = wnd[i - 1]!;
      const b = wnd[i]!;
      const ago = wnd.length - 1 - i;
      if (a.k <= a.d && b.k > b.d && Math.min(a.k, a.d) <= os + 8) crossUpAgo = ago;
      if (a.k >= a.d && b.k < b.d && Math.max(a.k, a.d) >= ob - 8) crossDnAgo = ago;
    }

    const last = m1[m1.length - 1]!;
    const prev = m1[m1.length - 2]!;
    const body = Math.max(Math.abs(last.close - last.open), 1e-9);
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const upperWick = last.high - Math.max(last.open, last.close);

    // pullback: nas ultimas 4 barras o preco tocou a regiao das EMAs
    const recentLows = l.slice(-4);
    const recentHighs = h.slice(-4);
    const touchedEmaLong = recentLows.some(
      (x) => x <= fast * (1 + pullbackTol) || x <= slow * (1 + pullbackTol),
    );
    const touchedEmaShort = recentHighs.some(
      (x) => x >= fast * (1 - pullbackTol) || x >= slow * (1 - pullbackTol),
    );

    // LONG
    const longOk =
      m5Bull &&
      fast > slow &&
      last.close > slow &&
      touchedEmaLong &&
      crossUpAgo >= 0 &&
      crossUpAgo <= 2 &&
      cur.k >= cur.d &&
      cur.k < 90 &&
      last.close > last.open &&
      lowerWick >= wickRatio * body &&
      (!requireBreak || last.close > prev.high); // rompe a maxima do candle anterior
    if (longOk) {
      const stopPrice = last.low - body * 0.1;
      const stopDistance = last.close - stopPrice;
      if (stopDistance <= 0 || stopDistance / last.close > maxStopPct) return null;
      return { contractType: "MULTUP", durationTicks: 0, tag: "MULTUP", multiplier, stopDistance, rr };
    }

    // SHORT
    const shortOk =
      m5Bear &&
      fast < slow &&
      last.close < slow &&
      touchedEmaShort &&
      crossDnAgo >= 0 &&
      crossDnAgo <= 2 &&
      cur.k <= cur.d &&
      cur.k > 10 &&
      last.close < last.open &&
      upperWick >= wickRatio * body &&
      (!requireBreak || last.close < prev.low);
    if (shortOk) {
      const stopPrice = last.high + body * 0.1;
      const stopDistance = stopPrice - last.close;
      if (stopDistance <= 0 || stopDistance / last.close > maxStopPct) return null;
      return { contractType: "MULTDOWN", durationTicks: 0, tag: "MULTDOWN", multiplier, stopDistance, rr };
    }
    return null;
  },
};

const REGISTRY: Record<string, Strategy> = {};
for (const s of [maCrossover, rsiReversion, momentumStrat, m1Scalp, m1Amd]) {
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
