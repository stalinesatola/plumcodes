export interface Candle {
  epoch: number; // inicio do candle (segundos)
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Agrega ticks em candles de periodo fixo (default M1 = 60s).
 * `add()` devolve o candle recem-FECHADO quando o bucket vira, senao null.
 */
export class CandleAggregator {
  private periodSec: number;
  private maxCandles: number;
  private cur: Candle | null = null;
  readonly closed: Candle[] = [];

  constructor(periodSec = 60, maxCandles = 400) {
    this.periodSec = periodSec;
    this.maxCandles = maxCandles;
  }

  /** Semeia com candles historicos (ex: de ticks_history style=candles). */
  seed(candles: Candle[]) {
    for (const c of candles.slice(-this.maxCandles)) this.closed.push(c);
  }

  add(quote: number, epochSec: number): Candle | null {
    const bucket = Math.floor(epochSec / this.periodSec) * this.periodSec;
    if (!this.cur) {
      this.cur = { epoch: bucket, open: quote, high: quote, low: quote, close: quote };
      return null;
    }
    if (bucket === this.cur.epoch) {
      this.cur.high = Math.max(this.cur.high, quote);
      this.cur.low = Math.min(this.cur.low, quote);
      this.cur.close = quote;
      return null;
    }
    // bucket novo -> fecha o anterior
    const done = this.cur;
    this.closed.push(done);
    if (this.closed.length > this.maxCandles) this.closed.shift();
    this.cur = { epoch: bucket, open: quote, high: quote, low: quote, close: quote };
    return done;
  }

  get current(): Candle | null {
    return this.cur;
  }

  closes(): number[] {
    return this.closed.map((c) => c.close);
  }
}

/** Reamostra candles menores em candles de `periodSec` (ex: M1 -> M5 -> M15).
 *  Descarta o bucket corrente incompleto — só devolve candles fechados. */
export function resample(cs: Candle[], periodSec: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
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
  if (cur) out.push(cur);
  return out.slice(0, -1);
}
