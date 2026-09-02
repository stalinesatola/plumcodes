/** Indicadores tecnicos simples, sem dependencias. Recebem arrays de precos (mais antigo -> mais recente). */

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
  }
  return prev;
}

export function rsi(values: number[], period: number): number | null {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

/**
 * Estocastico completo (%K desacelerado + %D). Recebe series OHLC alinhadas
 * (mais antigo -> recente). Retorna a serie de {k,d} ou [] se faltar dado.
 * Padrao Deriv/TradingView: kPeriod=14, slowing=3, dPeriod=3.
 */
export function stochastic(
  highs: number[],
  lows: number[],
  closes: number[],
  kPeriod: number,
  slowing: number,
  dPeriod: number,
): { k: number; d: number }[] {
  const n = closes.length;
  if (n < kPeriod + slowing + dPeriod) return [];
  const rawK: number[] = [];
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (highs[j]! > hh) hh = highs[j]!;
      if (lows[j]! < ll) ll = lows[j]!;
    }
    const range = hh - ll;
    rawK.push(range === 0 ? 50 : (100 * (closes[i]! - ll)) / range);
  }
  const smaOf = (arr: number[], p: number): number[] => {
    const out: number[] = [];
    for (let i = p - 1; i < arr.length; i++) {
      let s = 0;
      for (let j = i - p + 1; j <= i; j++) s += arr[j]!;
      out.push(s / p);
    }
    return out;
  };
  const kLine = smaOf(rawK, slowing);
  const dLine = smaOf(kLine, dPeriod);
  const offset = kLine.length - dLine.length;
  const out: { k: number; d: number }[] = [];
  for (let i = 0; i < dLine.length; i++) out.push({ k: kLine[i + offset]!, d: dLine[i]! });
  return out;
}

/**
 * Swings fractais: indices dos topos/fundos locais confirmados (uma barra cujo
 * high/low supera `k` barras de cada lado). Retorna os valores mais recentes.
 */
export function lastFractalSwings(
  highs: number[],
  lows: number[],
  k: number,
): { swingHigh: number | null; swingLow: number | null } {
  let swingHigh: number | null = null;
  let swingLow: number | null = null;
  for (let i = highs.length - 1 - k; i >= k; i--) {
    if (swingHigh === null) {
      let isHigh = true;
      for (let j = 1; j <= k; j++)
        if (!(highs[i]! > highs[i - j]! && highs[i]! > highs[i + j]!)) {
          isHigh = false;
          break;
        }
      if (isHigh) swingHigh = highs[i]!;
    }
    if (swingLow === null) {
      let isLow = true;
      for (let j = 1; j <= k; j++)
        if (!(lows[i]! < lows[i - j]! && lows[i]! < lows[i + j]!)) {
          isLow = false;
          break;
        }
      if (isLow) swingLow = lows[i]!;
    }
    if (swingHigh !== null && swingLow !== null) break;
  }
  return { swingHigh, swingLow };
}

/** Ultimo digito do preco na precisao 'pipSize' (0-9). */
export function lastDigit(quote: number, pipSize: number): number {
  const s = quote.toFixed(pipSize);
  return Number(s[s.length - 1]);
}

/** Frequencia de cada digito 0-9 nos ultimos 'n' digitos. Soma = 1. */
export function digitFreq(digits: number[], n: number): number[] {
  const slice = digits.slice(-n);
  const counts = new Array(10).fill(0);
  for (const d of slice) counts[d]++;
  const total = slice.length || 1;
  return counts.map((c) => c / total);
}

/** Comprimento da sequencia atual de mesma paridade (par/impar) no fim da serie. */
export function parityRun(digits: number[]): number {
  if (digits.length === 0) return 0;
  const last = digits[digits.length - 1]! % 2;
  let run = 0;
  for (let i = digits.length - 1; i >= 0 && digits[i]! % 2 === last; i--) run++;
  return run;
}

/** Retorno percentual simples entre o preco de 'lookback' atras e o atual. */
export function momentum(values: number[], lookback: number): number | null {
  if (values.length < lookback + 1) return null;
  const past = values[values.length - 1 - lookback]!;
  const now = values[values.length - 1]!;
  if (past === 0) return null;
  return (now - past) / past;
}

/** ADX (Wilder) — força da tendência (0-100). Candles do mais antigo -> mais recente.
 *  ADX > ~25 = mercado direcional; < ~20 = lateral. Precisa de ~2*period+1 candles. */
export function adx(
  candles: Array<{ high: number; low: number; close: number }>,
  period = 14,
): number | null {
  if (candles.length < period * 2 + 1) return null;
  const tr: number[] = [];
  const pDM: number[] = [];
  const nDM: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const p = candles[i - 1]!;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    const up = c.high - p.high;
    const down = p.low - c.low;
    pDM.push(up > down && up > 0 ? up : 0);
    nDM.push(down > up && down > 0 ? down : 0);
  }
  // suavização de Wilder
  const wilder = (arr: number[]): number[] => {
    const out: number[] = [];
    let acc = arr.slice(0, period).reduce((a, b) => a + b, 0);
    out.push(acc);
    for (let i = period; i < arr.length; i++) {
      acc = acc - acc / period + arr[i]!;
      out.push(acc);
    }
    return out;
  };
  const trS = wilder(tr);
  const pS = wilder(pDM);
  const nS = wilder(nDM);
  const dx: number[] = [];
  for (let i = 0; i < trS.length; i++) {
    const t = trS[i]!;
    if (t <= 0) {
      dx.push(0);
      continue;
    }
    const pDI = (100 * pS[i]!) / t;
    const nDI = (100 * nS[i]!) / t;
    const sum = pDI + nDI;
    dx.push(sum > 0 ? (100 * Math.abs(pDI - nDI)) / sum : 0);
  }
  if (dx.length < period) return null;
  // ADX = média de Wilder do DX sobre `period`
  let a = dx.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < dx.length; i++) a = (a * (period - 1) + dx[i]!) / period;
  return a;
}
