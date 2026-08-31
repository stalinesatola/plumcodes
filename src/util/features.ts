import type { StrategyContext, TradeIntent } from "../types.ts";
import { digitFreq, parityRun, rsi, sma } from "./indicators.ts";

const CONTRACT_CODES: Record<string, number> = {
  CALL: 1,
  PUT: 2,
  DIGITMATCH: 3,
  DIGITDIFF: 4,
  DIGITOVER: 5,
  DIGITUNDER: 6,
  DIGITEVEN: 7,
  DIGITODD: 8,
};

/**
 * Vetor de features estavel (mesma dimensao sempre) para o modelo online.
 * Combina sinais de digito e de preco + o contexto da aposta candidata.
 */
export function buildFeatures(ctx: StrategyContext, intent: TradeIntent): number[] {
  const d = ctx.digits;
  const p = ctx.prices;

  const last8 = d.slice(-8);
  while (last8.length < 8) last8.unshift(0);
  const digitsNorm = last8.map((x) => x / 9);

  const freq = digitFreq(d, 50); // 10 valores

  const run = Math.min(parityRun(d), 10) / 10;

  const rsiV = (rsi(p, 14) ?? 50) / 100;
  const fast = sma(p, 5);
  const slow = sma(p, 20);
  const maRatio = fast && slow ? Math.max(-0.05, Math.min(0.05, fast / slow - 1)) * 20 : 0;

  const rets: number[] = [];
  for (let i = Math.max(1, p.length - 5); i < p.length; i++) {
    const prev = p[i - 1]!;
    rets.push(prev ? Math.sign(p[i]! - prev) : 0);
  }
  while (rets.length < 5) rets.unshift(0);

  const code = (CONTRACT_CODES[intent.contractType] ?? 0) / 8;
  const barrier = intent.barrier ? Number(intent.barrier) / 9 : 0;

  return [
    ...digitsNorm, // 8
    ...freq, // 10
    run, // 1
    rsiV, // 1
    maRatio, // 1
    ...rets, // 5
    code, // 1
    barrier, // 1
    ctx.tuning, // 1
  ]; // total 29
}
