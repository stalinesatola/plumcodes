/**
 * Caracteriza frxXAUUSD a partir de data/gold-frxXAUUSD-60.json:
 *  - cobertura / gaps
 *  - volatilidade por hora UTC (desvio-padrao do retorno M1, ATR medio)
 *  - tamanho tipico de candle M1/M5/M15 (range em $ e em pips de 0.01)
 *  - autocorrelacao lag-1 dos retornos M1/M5/M15 (>0 = tende a continuar / trend; <0 = reverter)
 *  - variance ratio (VR(q)) M5 e M15 (>1 trend, <1 mean-revert)
 *  - comportamento por sessao (Asia/Londres/NY/overlap)
 *
 * Uso: node tools/gold-characterize.ts [caminhoJson]
 */
import { readFileSync } from "node:fs";
import { resample } from "../src/util/candles.ts";
import type { Candle } from "../src/types.ts";

const path = process.argv[2] || "data/gold-frxXAUUSD-60.json";
const raw = JSON.parse(readFileSync(path, "utf8"));
const m1: Candle[] = raw.candles;
m1.sort((a, b) => a.epoch - b.epoch);

function rets(cs: Candle[]): number[] {
  const o: number[] = [];
  for (let i = 1; i < cs.length; i++) {
    // so retornos "contiguos" (sem gap grande de tempo)
    o.push(Math.log(cs[i]!.close / cs[i - 1]!.close));
  }
  return o;
}
function acf1(x: number[]): number {
  const n = x.length;
  const m = x.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) den += (x[i]! - m) ** 2;
  for (let i = 1; i < n; i++) num += (x[i]! - m) * (x[i - 1]! - m);
  return num / den;
}
function varianceRatio(r: number[], q: number): number {
  // VR(q) = Var(sum de q retornos) / (q * Var(retorno)). ~1 random walk.
  const n = r.length;
  const m = r.reduce((a, b) => a + b, 0) / n;
  let v1 = 0;
  for (const x of r) v1 += (x - m) ** 2;
  v1 /= n;
  const agg: number[] = [];
  for (let i = 0; i + q <= n; i++) {
    let s = 0;
    for (let j = 0; j < q; j++) s += r[i + j]!;
    agg.push(s);
  }
  const ma = agg.reduce((a, b) => a + b, 0) / agg.length;
  let vq = 0;
  for (const x of agg) vq += (x - ma) ** 2;
  vq /= agg.length;
  return vq / (q * v1);
}

// ---- cobertura / gaps ----
const first = new Date(m1[0]!.epoch * 1000).toISOString();
const last = new Date(m1[m1.length - 1]!.epoch * 1000).toISOString();
const spanDays = (m1[m1.length - 1]!.epoch - m1[0]!.epoch) / 86400;
let gaps = 0, biggestGap = 0;
for (let i = 1; i < m1.length; i++) {
  const d = m1[i]!.epoch - m1[i - 1]!.epoch;
  if (d > 60) { gaps++; biggestGap = Math.max(biggestGap, d); }
}
console.log("===== COBERTURA =====");
console.log(`arquivo         ${path}`);
console.log(`candles M1      ${m1.length}`);
console.log(`periodo         ${first} -> ${last}  (${spanDays.toFixed(1)} dias calendario)`);
console.log(`dias de pregao  ~${(m1.length / 1380).toFixed(1)} (1380 min/dia util)`);
console.log(`gaps (>60s)     ${gaps}   maior: ${(biggestGap / 3600).toFixed(1)}h`);
const px = m1[m1.length - 1]!.close;
console.log(`preco atual     ${px}`);

// ---- tamanho de candle / ATR ----
function candleStats(cs: Candle[], label: string) {
  const ranges = cs.map((c) => c.high - c.low);
  const bodies = cs.map((c) => Math.abs(c.close - c.open));
  ranges.sort((a, b) => a - b);
  const med = ranges[Math.floor(ranges.length / 2)]!;
  const meanR = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const meanB = bodies.reduce((a, b) => a + b, 0) / bodies.length;
  // ATR14 medio
  let atrSum = 0, atrN = 0;
  for (let i = 14; i < cs.length; i++) {
    let tr = 0;
    for (let j = i - 13; j <= i; j++) {
      const c = cs[j]!, p = cs[j - 1]!;
      tr += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    atrSum += tr / 14; atrN++;
  }
  const atr = atrSum / atrN;
  console.log(`${label.padEnd(4)}  range med $${med.toFixed(2)} (${(med / 0.01).toFixed(0)}p)  range mean $${meanR.toFixed(2)}  body mean $${meanB.toFixed(2)}  ATR14 $${atr.toFixed(2)} (${(atr / 0.01).toFixed(0)}p)`);
}
const m5 = resample(m1, 300);
const m15 = resample(m1, 900);
console.log("\n===== TAMANHO DE CANDLE / ATR =====");
candleStats(m1, "M1");
candleStats(m5, "M5");
candleStats(m15, "M15");

// ---- autocorrelacao / variance ratio ----
const r1 = rets(m1), r5 = rets(m5), r15 = rets(m15);
console.log("\n===== AUTOCORRELACAO lag-1  (>0 trend, <0 reversao) =====");
console.log(`M1   acf1 ${acf1(r1).toFixed(4)}   (n=${r1.length})`);
console.log(`M5   acf1 ${acf1(r5).toFixed(4)}   (n=${r5.length})`);
console.log(`M15  acf1 ${acf1(r15).toFixed(4)}   (n=${r15.length})`);
console.log("\n===== VARIANCE RATIO  (>1 trend/momentum, <1 mean-revert) =====");
for (const q of [2, 4, 8]) console.log(`M5   VR(${q})  ${varianceRatio(r5, q).toFixed(3)}`);
for (const q of [2, 4, 8]) console.log(`M15  VR(${q})  ${varianceRatio(r15, q).toFixed(3)}`);

// ---- por hora UTC ----
console.log("\n===== VOLATILIDADE POR HORA UTC =====");
console.log("hora  nCandles  stdRetM1(bps)  rangeMedioM1($)  |  sessao");
const byHour: Record<number, number[]> = {};
const byHourRange: Record<number, number[]> = {};
for (let i = 1; i < m1.length; i++) {
  if (m1[i]!.epoch - m1[i - 1]!.epoch > 60) continue;
  const h = new Date(m1[i]!.epoch * 1000).getUTCHours();
  (byHour[h] ??= []).push(Math.log(m1[i]!.close / m1[i - 1]!.close));
  (byHourRange[h] ??= []).push(m1[i]!.high - m1[i]!.low);
}
function sessLabel(h: number): string {
  const s: string[] = [];
  if (h >= 0 && h < 8) s.push("Asia");
  if (h >= 7 && h < 16) s.push("Londres");
  if (h >= 12 && h < 21) s.push("NY");
  if (h >= 12 && h < 16) s.push("OVERLAP");
  return s.join("+") || "-";
}
for (let h = 0; h < 24; h++) {
  const arr = byHour[h] || [];
  if (!arr.length) { console.log(`${String(h).padStart(2, "0")}h   (sem dados)`); continue; }
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
  const rr = (byHourRange[h] || []).slice().sort((a, b) => a - b);
  const medR = rr[Math.floor(rr.length / 2)] || 0;
  console.log(`${String(h).padStart(2, "0")}h   ${String(arr.length).padStart(6)}    ${(sd * 10000).toFixed(2).padStart(8)}      ${medR.toFixed(2).padStart(8)}     |  ${sessLabel(h)}`);
}

// ---- por sessao: acf e VR ----
console.log("\n===== AUTOCORRELACAO M5 POR SESSAO =====");
function sessionOf(epoch: number): string {
  const h = new Date(epoch * 1000).getUTCHours();
  if (h >= 12 && h < 16) return "overlap(12-16)";
  if (h >= 7 && h < 12) return "londres(07-12)";
  if (h >= 16 && h < 21) return "ny_tarde(16-21)";
  if (h >= 0 && h < 7) return "asia(00-07)";
  return "outro(21-24)";
}
const bySess: Record<string, number[]> = {};
for (let i = 1; i < m5.length; i++) {
  if (m5[i]!.epoch - m5[i - 1]!.epoch > 300 * 2) continue;
  (bySess[sessionOf(m5[i]!.epoch)] ??= []).push(Math.log(m5[i]!.close / m5[i - 1]!.close));
}
for (const [k, v] of Object.entries(bySess)) {
  const sd = Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length);
  console.log(`${k.padEnd(16)} n=${String(v.length).padStart(5)}  acf1 ${acf1(v).toFixed(4)}  stdRet ${(sd * 10000).toFixed(1)}bps  VR(4) ${varianceRatio(v, 4).toFixed(3)}`);
}
