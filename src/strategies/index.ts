import type { Strategy, StrategyContext, TradeIntent, Candle } from "../types.ts";
import { sma, ema, rsi, stochastic, heikinAshi } from "../util/indicators.ts";

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
// 5) gold_trend_scalp — scalp de pullback A FAVOR da tendência M5 (spec do usuário).
//    EMA50(M5) define a direção. Estocástico(14,3,3) saindo de sobrevenda/sobrecompra
//    (cruzamento K×D) marca o fim do pullback. Candle M5 de rejeição (pavio longo)
//    tocando a banda de Bollinger(20,2) é o gatilho. Alvo curto (rr ~1.5), stop de
//    scalp (min(maxStopUsd, ATR-M1) ou abaixo do pavio).
// ============================================================================
const goldTrendScalp: Strategy = {
  name: "gold_trend_scalp",
  warmup: 60,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const emaP = Math.round(p.emaPeriod ?? 50);
    const kP = Math.round(p.stochK ?? 14);
    const kSlow = Math.round(p.stochSlow ?? 3);
    const dP = Math.round(p.stochD ?? 3);
    const stochOs = p.stochOs ?? 20;
    const stochOb = p.stochOb ?? 80;
    const bbP = Math.round(p.bbPeriod ?? 20);
    const bbK = p.bbK ?? 2.0;
    const wickRatio = p.wickRatio ?? 0.5; // pavio de rejeição >= metade do range
    const mult = p.multiplier ?? 100;
    const rr = p.rr ?? 1.5;
    const stopAtrMult = p.stopAtrMult ?? 1.2;
    const maxStopUsd = p.maxStopUsd ?? 4.0; // teto do stop (scalp)
    const tfSec = Math.round(p.tf ?? 300); // timeframe de análise: 300 = M5 (padrão), 60 = M1
    const hStart = p.tradeStart ?? 0;
    const hEnd = p.tradeEnd ?? 24;

    const m1 = ctx.candles;
    const tf = rs(m1, tfSec);
    const need = Math.max(emaP, bbP, kP + kSlow + dP) + 6;
    if (tf.length < need || m1.length < 20) return null;
    const h = hourUTC(m1[m1.length - 1]!.epoch);
    if (!inWin(h, hStart, hEnd)) return null;

    const closed = tfSec <= 60 ? tf : tf.slice(0, -1); // barras fechadas do timeframe
    const last = closed[closed.length - 1]!; // candle de rejeição
    const cl = closed.map((c) => c.close);
    const price = m1[m1.length - 1]!.close;

    const emaVal = ema(cl, emaP);
    if (emaVal == null) return null;

    const st = stochastic(
      closed.map((c) => c.high),
      closed.map((c) => c.low),
      cl,
      kP,
      kSlow,
      dP,
    );
    if (st.length < 3) return null;
    const s0 = st[st.length - 1]!;
    const s1 = st[st.length - 2]!;
    const s2 = st[st.length - 3]!;

    const mid = sma(cl, bbP);
    if (mid == null) return null;
    const slice = cl.slice(-bbP);
    const sd = Math.sqrt(slice.reduce((a, x) => a + (x - mid) ** 2, 0) / bbP);
    const upper = mid + bbK * sd;
    const lower = mid - bbK * sd;

    const range = last.high - last.low;
    if (range <= 0) return null;
    const lowerWick = Math.min(last.open, last.close) - last.low;
    const upperWick = last.high - Math.max(last.open, last.close);

    const a1 = atr(m1.slice(-30), 14); // ATR(M1) — stop de scalp
    if (a1 == null || a1 <= 0) return null;

    // estocástico: mergulhou em sobrevenda nas últimas 3 barras e agora sobe (K subindo)
    const turningUp = s0.k > s1.k && Math.min(s0.k, s1.k, s2.k) <= stochOs && s0.k < 55;
    const turningDown = s0.k < s1.k && Math.max(s0.k, s1.k, s2.k) >= stochOb && s0.k > 45;

    // COMPRA: preço acima da EMA(timeframe) + estocástico saindo de sobrevenda +
    // candle de rejeição (pavio inferior longo, fechou na metade de cima) tocando
    // a banda inferior de Bollinger
    const rejectLow = lowerWick / range >= wickRatio && last.close >= last.low + range * 0.5 && last.low <= lower;
    if (price > emaVal && turningUp && rejectLow) {
      const stopDistance = Math.min(maxStopUsd, Math.max(stopAtrMult * a1, price - last.low + 0.15 * a1));
      return { contractType: "MULTUP", durationTicks: 0, tag: "scalp_buy", multiplier: mult, stopDistance, rr };
    }

    const rejectHigh = upperWick / range >= wickRatio && last.close <= last.high - range * 0.5 && last.high >= upper;
    if (price < emaVal && turningDown && rejectHigh) {
      const stopDistance = Math.min(maxStopUsd, Math.max(stopAtrMult * a1, last.high - price + 0.15 * a1));
      return { contractType: "MULTDOWN", durationTicks: 0, tag: "scalp_sell", multiplier: mult, stopDistance, rr };
    }
    return null;
  },
};

// ============================================================================
// 6) gold_fimathe — aproximação AUTOMÁTICA da metodologia FIMATHE (Marcelo Ferreira).
//    FIMATHE é discricionária (o trader desenha os canais à mão nos momentos certos);
//    isto é uma leitura automatizada dos conceitos centrais:
//      - CANAL DE REFERÊNCIA (M15): range das últimas `refBars` velas M15 fechadas.
//        W = altura; equador = 50%.
//      - ZONA NEUTRA: uma largura W do lado CONTRÁRIO à tendência (não se opera nela).
//      - TENDÊNCIA: preço vs EMA(M15, trendEma) e vs equador.
//      - ENTRADA:
//          mode "equador" (padrão): a favor da tendência, quando o preço RECUA até
//            ~50% do canal (equador) e a vela M15 fecha retomando a direção.
//          mode "rompimento": a favor da tendência, quando o preço ROMPE o canal de
//            referência saindo da zona neutra.
//      - STOP: além da zona neutra (chanLo - W p/ compra); alvo = rr*stop.
//    O "sub-ciclo de proteção" (mover stop p/ 0x0 aos 50%) é coberto pelo
//    manageStop do bot (break-even + trailing).
// ============================================================================
const goldFimathe: Strategy = {
  name: "gold_fimathe",
  warmup: 60,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const refBars = Math.round(p.refBars ?? 4); // velas M15 do canal de referência (~1h)
    const trendEma = Math.round(p.trendEma ?? 20);
    const equadorTol = p.equadorTol ?? 0.18; // faixa em torno do 50%
    const mode = p.mode === 1 ? "rompimento" : "equador"; // params são numéricos: 1 = rompimento
    const rr = p.rr ?? 2.0;
    const maxStopUsd = p.maxStopUsd ?? 8;
    const mult = p.multiplier ?? 100;
    const hStart = p.tradeStart ?? 0;
    const hEnd = p.tradeEnd ?? 24;

    const m1 = ctx.candles;
    const m15 = rs(m1, 900);
    if (m15.length < Math.max(refBars, trendEma) + 6) return null;
    const h = hourUTC(m1[m1.length - 1]!.epoch);
    if (!inWin(h, hStart, hEnd)) return null;

    const closed = m15.slice(0, -1); // velas M15 fechadas
    const last = closed[closed.length - 1]!; // vela de sinal (recém-fechada)
    const prev = closed[closed.length - 2]!;
    const cl = closed.map((c) => c.close);
    const price = m1[m1.length - 1]!.close;

    // canal de referência: range das refBars velas ANTERIORES à vela de sinal
    const refWin = closed.slice(-1 - refBars, -1);
    if (refWin.length < refBars) return null;
    const chanHi = Math.max(...refWin.map((c) => c.high));
    const chanLo = Math.min(...refWin.map((c) => c.low));
    const W = chanHi - chanLo;
    if (W <= 0) return null;
    const equador = (chanHi + chanLo) / 2;
    const buffer = 0.1 * W;

    const ema15 = ema(cl, trendEma);
    if (ema15 == null) return null;
    const up = price > ema15 && price > equador;
    const dn = price < ema15 && price < equador;

    if (mode === "rompimento") {
      if (up && last.close > chanHi && prev.close <= chanHi) {
        const stopDistance = Math.min(maxStopUsd, Math.max(0.3, price - (chanLo - W)));
        return { contractType: "MULTUP", durationTicks: 0, tag: "fim_buy", multiplier: mult, stopDistance, rr };
      }
      if (dn && last.close < chanLo && prev.close >= chanLo) {
        const stopDistance = Math.min(maxStopUsd, Math.max(0.3, (chanHi + W) - price));
        return { contractType: "MULTDOWN", durationTicks: 0, tag: "fim_sell", multiplier: mult, stopDistance, rr };
      }
      return null;
    }

    // mode "equador": recuo ao 50% do canal e retomada da tendência
    if (up) {
      const touched = last.low <= equador + equadorTol * W && last.low >= chanLo - buffer;
      const resumed = last.close > last.open && last.close > equador;
      if (touched && resumed) {
        const stopDistance = Math.min(maxStopUsd, Math.max(0.3, price - (chanLo - buffer)));
        return { contractType: "MULTUP", durationTicks: 0, tag: "fim_buy", multiplier: mult, stopDistance, rr };
      }
    }
    if (dn) {
      const touched = last.high >= equador - equadorTol * W && last.high <= chanHi + buffer;
      const resumed = last.close < last.open && last.close < equador;
      if (touched && resumed) {
        const stopDistance = Math.min(maxStopUsd, Math.max(0.3, (chanHi + buffer) - price));
        return { contractType: "MULTDOWN", durationTicks: 0, tag: "fim_sell", multiplier: mult, stopDistance, rr };
      }
    }
    return null;
  },
};

// ============================================================================
// 8) gold_m1_hf_scalp — scalping AGRESSIVO de alta frequência no M1 (spec do usuário).
//    Momentum: EMA5 x EMA13 + RSI(7). Entrada: rompimento da máx/mín local de
//    `breakoutLookback` velas COM expansão de volatilidade (range da vela entre
//    expandMult e newsMult vezes o ATR — precisa expandir, mas não pode ser um
//    spike de notícia). Stop curto fixo (stopPips*pipValue, com piso 0.5*ATR e
//    teto maxStopUsd), alvo = rr*stop. Trailing (via manageStop do bot). Só nas
//    aberturas de Londres e NY; pula a janela do NFP (1ª sexta, ~12:15-13:15 UTC).
// ============================================================================
const goldM1HfScalp: Strategy = {
  name: "gold_m1_hf_scalp",
  warmup: 30,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const emaFastP = Math.round(p.emaFast ?? 5);
    const emaSlowP = Math.round(p.emaSlow ?? 13);
    const rsiP = Math.round(p.rsiPeriod ?? 7);
    const rsiBuyMax = p.rsiBuyMax ?? 72;
    const rsiSellMin = p.rsiSellMin ?? 28;
    const brk = Math.round(p.breakoutLookback ?? 5);
    const expandMult = p.expandMult ?? 1.2;
    const newsMult = p.newsMult ?? 3.0;
    const atrP = Math.round(p.atrPeriod ?? 14);
    const pipValue = p.pipValue ?? 0.1; // 1 "pip" de ouro ≈ $0.10 (convenção retail)
    const stopPips = p.stopPips ?? 7;
    const maxStopUsd = p.maxStopUsd ?? 2.5;
    const rr = p.rr ?? 1.75;
    const mult = p.multiplier ?? 100;
    const lonS = p.tradeStart ?? 7, lonE = p.tradeEnd ?? 10; // abertura de Londres
    const nyS = p.tradeStart2 ?? 12, nyE = p.tradeEnd2 ?? 15; // abertura de NY

    const m1 = ctx.candles;
    if (m1.length < Math.max(emaSlowP, brk, atrP) + 6) return null;

    const now = m1[m1.length - 1]!; // vela M1 de sinal (recém-fechada)
    const dt = new Date(now.epoch * 1000);
    const hf = dt.getUTCHours() + dt.getUTCMinutes() / 60;
    if (!inWin(hf, lonS, lonE) && !inWin(hf, nyS, nyE)) return null;
    // pula a janela do NFP (1ª sexta-feira do mês, ~12:15–13:15 UTC)
    if (dt.getUTCDay() === 5 && dt.getUTCDate() <= 7 && hf >= 12.25 && hf <= 13.25) return null;

    const closes = m1.map((c) => c.close);
    const eF = ema(closes, emaFastP);
    const eS = ema(closes, emaSlowP);
    const rv = rsi(closes, rsiP);
    const rvPrev = rsi(closes.slice(0, -1), rsiP);
    const a = atr(m1.slice(-(atrP + 5)), atrP);
    if (eF == null || eS == null || rv == null || rvPrev == null || a == null || a <= 0) return null;

    const ratio = (now.high - now.low) / a;
    if (ratio < expandMult || ratio > newsMult) return null;

    const win = m1.slice(-1 - brk, -1);
    const hi = Math.max(...win.map((c) => c.high));
    const lo = Math.min(...win.map((c) => c.low));

    const stopDistance = Math.min(maxStopUsd, Math.max(stopPips * pipValue, 0.5 * a));

    if (eF > eS && rv > rvPrev && rv < rsiBuyMax && now.close > hi) {
      return { contractType: "MULTUP", durationTicks: 0, tag: "hf_buy", multiplier: mult, stopDistance, rr };
    }
    if (eF < eS && rv < rvPrev && rv > rsiSellMin && now.close < lo) {
      return { contractType: "MULTDOWN", durationTicks: 0, tag: "hf_sell", multiplier: mult, stopDistance, rr };
    }
    return null;
  },
};

// ============================================================================
// 7) gold_h1_trend — seguimento de tendência no H1 (spec do usuário).
//    Lê a tendência com EMA50 + EMA200 (H1), o momentum com RSI, e filtra
//    mercado morto / caos extremo com ATR(H1) em % do preço.
//      COMPRA: preço acima das DUAS EMAs, EMA50 > EMA200, RSI forte (>= rsiBull)
//              e subindo, ATR dentro da faixa "viva".
//      VENDA: preço abaixo das DUAS EMAs, EMA50 < EMA200, RSI fraco (<= rsiBear)
//             e caindo, ATR dentro da faixa.
//    Fora dessas condições (ex.: preço entre as EMAs, RSI neutro, ATR baixo) o
//    bot NÃO opera — é o "ignora o ouro quando está só oscilando".
//    Stop = stopAtrMult * ATR(H1); alvo = rr * stop.
// ============================================================================
const goldH1Trend: Strategy = {
  name: "gold_h1_trend",
  warmup: 60,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const emaFastP = Math.round(p.emaFast ?? 50);
    const emaSlowP = Math.round(p.emaSlow ?? 200);
    const rsiP = Math.round(p.rsiPeriod ?? 14);
    const rsiBull = p.rsiBull ?? 55;
    const rsiBear = p.rsiBear ?? 45;
    const atrP = Math.round(p.atrPeriod ?? 14);
    const atrMinPct = p.atrMinPct ?? 0.0015; // < isto = mercado morto
    const atrMaxPct = p.atrMaxPct ?? 0.012; // > isto = caos / news extremo
    const stopAtrMult = p.stopAtrMult ?? 1.5;
    const rr = p.rr ?? 2.0;
    const mult = p.multiplier ?? 100;
    const hStart = p.tradeStart ?? 0;
    const hEnd = p.tradeEnd ?? 24;

    const h1 = ctx.h1;
    if (!h1 || h1.length < emaSlowP + 2) return null; // EMA(emaSlow) precisa de emaSlow barras + 1 p/ o rsiPrev
    const h = hourUTC(ctx.candles[ctx.candles.length - 1]?.epoch ?? 0);
    if (!inWin(h, hStart, hEnd)) return null;

    const closes = h1.map((c) => c.close);
    const price = ctx.price || closes[closes.length - 1]!;

    const eF = ema(closes, emaFastP);
    const eS = ema(closes, emaSlowP);
    const rv = rsi(closes, rsiP);
    const rvPrev = rsi(closes.slice(0, -1), rsiP);
    const a = atr(h1.slice(-(atrP + 5)), atrP);
    if (eF == null || eS == null || rv == null || rvPrev == null || a == null || a <= 0) return null;

    // filtro de volatilidade
    const atrPct = a / price;
    if (atrPct < atrMinPct || atrPct > atrMaxPct) return null;

    const stopDistance = stopAtrMult * a;
    const rsiRising = rv > rvPrev;
    const rsiFalling = rv < rvPrev;

    if (price > eF && price > eS && eF > eS && rv >= rsiBull && rsiRising) {
      return { contractType: "MULTUP", durationTicks: 0, tag: "h1_buy", multiplier: mult, stopDistance, rr };
    }
    if (price < eF && price < eS && eF < eS && rv <= rsiBear && rsiFalling) {
      return { contractType: "MULTDOWN", durationTicks: 0, tag: "h1_sell", multiplier: mult, stopDistance, rr };
    }
    return null;
  },
};

// ============================================================================
// 9) gold_ha_channel — canal 55-MA(High)/55-MA(Low) + Heikin Ashi (spec do usuário).
//    - Canal = SMA(55) dos highs e SMA(55) dos lows. NÃO opera dentro do canal.
//    - COMPRA: preço rompe acima da 55-MA(High) com vela Heikin Ashi VERDE.
//      VENDA: rompe abaixo da 55-MA(Low) com vela HA VERMELHA.
//    - Filtro HTF (opcional, htfFilter): SMA(200) no H1 — só compra acima, só vende abaixo.
//    - Stop = max(ATR*2.5, além da mínima/máxima da vela anterior). Alvo rr 1.5.
//      "Após 1:1.5 mover p/ break-even" -> manageStop breakEvenAtR 1.5 + trailing folgado.
//    - Sessões: Ásia (0-9 UTC) + NY (12-21 UTC).
//    tf: 300 = M5 (padrão), 60 = M1.
// ============================================================================
const goldHaChannel: Strategy = {
  name: "gold_ha_channel",
  warmup: 60,
  kind: "candle",
  evaluate(ctx: StrategyContext): TradeIntent | null {
    if (!ctx.candleClosed) return null;
    const p = ctx.params;
    const maP = Math.round(p.maPeriod ?? 55);
    const tfSec = Math.round(p.tf ?? 300);
    const atrP = Math.round(p.atrPeriod ?? 14);
    const atrMult = p.stopAtrMult ?? 2.5;
    const rr = p.rr ?? 1.5;
    const mult = p.multiplier ?? 100;
    const htfFilter = (p.htfFilter ?? 1) !== 0;
    const htfMaP = Math.round(p.htfMaPeriod ?? 200);
    const asiaS = p.tradeStart ?? 0, asiaE = p.tradeEnd ?? 9;
    const nyS = p.tradeStart2 ?? 12, nyE = p.tradeEnd2 ?? 21;

    const m1 = ctx.candles;
    const tf = rs(m1, tfSec);
    const closedTf = tfSec <= 60 ? tf : tf.slice(0, -1);
    if (closedTf.length < maP + 6) return null;

    const now = m1[m1.length - 1]!;
    const hf = hourUTC(now.epoch) + new Date(now.epoch * 1000).getUTCMinutes() / 60;
    if (!inWin(hf, asiaS, asiaE) && !inWin(hf, nyS, nyE)) return null;

    const maHigh = sma(closedTf.map((c) => c.high), maP);
    const maLow = sma(closedTf.map((c) => c.low), maP);
    if (maHigh == null || maLow == null) return null;

    const price = now.close;
    const lastTf = closedTf[closedTf.length - 1]!;
    const prevTf = closedTf[closedTf.length - 2]!;

    // filtro do canal — não opera dentro
    if (price >= maLow && price <= maHigh) return null;

    const ha = heikinAshi(closedTf.slice(-40));
    const ha0 = ha[ha.length - 1]!;
    const ha1 = ha[ha.length - 2]!;
    const green = ha0.close > ha0.open;
    const red = ha0.close < ha0.open;
    const wasGreen = ha1.close > ha1.open;
    const wasRed = ha1.close < ha1.open;

    const a = atr(closedTf.slice(-(atrP + 5)), atrP);
    if (a == null || a <= 0) return null;

    let htfOkBuy = true;
    let htfOkSell = true;
    if (htfFilter && ctx.h1 && ctx.h1.length >= htfMaP) {
      const htfMa = sma(
        ctx.h1.map((c) => c.close),
        htfMaP,
      );
      if (htfMa != null) {
        htfOkBuy = price > htfMa;
        htfOkSell = price < htfMa;
      }
    }

    // COMPRA: rompeu acima da 55-MA(High) (fresco) + HA verde + HTF ok
    const brokeUp = lastTf.close > maHigh && prevTf.close <= maHigh;
    if ((brokeUp || (price > maHigh && !wasGreen && green)) && green && htfOkBuy) {
      const stopDistance = Math.max(atrMult * a, price - lastTf.low + 0.1 * a);
      return { contractType: "MULTUP", durationTicks: 0, tag: "ha_buy", multiplier: mult, stopDistance, rr };
    }
    const brokeDn = lastTf.close < maLow && prevTf.close >= maLow;
    if ((brokeDn || (price < maLow && !wasRed && red)) && red && htfOkSell) {
      const stopDistance = Math.max(atrMult * a, lastTf.high - price + 0.1 * a);
      return { contractType: "MULTDOWN", durationTicks: 0, tag: "ha_sell", multiplier: mult, stopDistance, rr };
    }
    return null;
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
  goldTrendScalp,
  goldFimathe,
  goldH1Trend,
  goldM1HfScalp,
  goldHaChannel,
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
