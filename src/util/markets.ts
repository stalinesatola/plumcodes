/** O único par operado: BTC/USD (Deriv só oferece MULTUP/MULTDOWN neste símbolo). */
export const BTC_SYMBOL = "cryBTCUSD";

/**
 * BTC é 24/7 — não há "sessões" de câmbio. O que importa para operar BTC
 * intradiário é o REGIME DE VOLATILIDADE: quando o mercado está a mexer o
 * suficiente para os alvos compensarem a comissão do multiplicador (~2–4× a
 * do ouro), e em que horas UTC essa volatilidade costuma concentrar-se.
 *
 * As funções abaixo trabalham sobre candles OHLC (tipicamente H1, ~10–15 dias)
 * e são consumidas só pelo monitor.
 */
export interface OHLC {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/** ATR (Wilder simplificado — média do true range) sobre os últimos `period` candles. */
export function atr(candles: OHLC[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const slice = tr.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / slice.length;
}

/** ATR do candle mais recente, em % do preço de fecho. */
export function atrPct(candles: OHLC[], period = 14): number | null {
  const a = atr(candles, period);
  const last = candles[candles.length - 1]?.close;
  if (a == null || !last) return null;
  return (a / last) * 100;
}

/** Mediana do ATR% ao longo de uma janela deslizante (baseline "normal"). */
export function atrPctBaseline(candles: OHLC[], period = 14, window = 24 * 10): number | null {
  if (candles.length < period + 5) return null;
  const vals: number[] = [];
  const start = Math.max(period + 1, candles.length - window);
  for (let i = start; i <= candles.length; i++) {
    const v = atrPct(candles.slice(0, i), period);
    if (v != null) vals.push(v);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)]!;
}

export type VolRegime = "morto" | "calmo" | "normal" | "agitado" | "extremo";

/** Classifica a volatilidade atual vs a baseline. */
export function volRegime(cur: number | null, baseline: number | null): VolRegime | null {
  if (cur == null || baseline == null || baseline <= 0) return null;
  const r = cur / baseline;
  if (r < 0.55) return "morto";
  if (r < 0.85) return "calmo";
  if (r <= 1.4) return "normal";
  if (r <= 2.2) return "agitado";
  return "extremo";
}

/**
 * Perfil horário de volatilidade: média de (high-low)/open por hora UTC (0–23)
 * ao longo de todos os candles fornecidos. Serve para ver em que horas o BTC
 * costuma mover-se mais — e portanto quando os bots tendem a ter alvos válidos.
 */
export function hourlyRangeProfile(candles: OHLC[]): number[] {
  const sum = new Array(24).fill(0);
  const cnt = new Array(24).fill(0);
  for (const c of candles) {
    if (!c.open) continue;
    const h = new Date(c.epoch * 1000).getUTCHours();
    sum[h] += ((c.high - c.low) / c.open) * 100;
    cnt[h] += 1;
  }
  return sum.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
}
