/**
 * Bateria de backtests das estrategias de Gold sobre data/gold-frxXAUUSD-60.json,
 * carregando os candles UMA vez. Ranqueia por expectancy LIQUIDA (com custo Deriv).
 *
 * Uso: node tools/gold-backtest-suite.ts [caminhoJson]
 *
 * stepBars: de quantos em quantos candles M1 a estrategia e avaliada (o sinal so
 *   muda no fechamento do timeframe dela). maxBars: horizonte (em M1) para o
 *   trade resolver (SL/TP); trades que nao resolvem sao descartados.
 */
import { readFileSync } from "node:fs";
import { runBacktest } from "./_sim.ts";
import type { Candle } from "../src/types.ts";

const path = process.argv[2] || "data/gold-frxXAUUSD-60.json";
const all: Candle[] = JSON.parse(readFileSync(path, "utf8")).candles;
all.sort((a, b) => a.epoch - b.epoch);
console.log(`${all.length} candles M1 (${new Date(all[0]!.epoch * 1000).toISOString().slice(0, 10)} -> ${new Date(all[all.length - 1]!.epoch * 1000).toISOString().slice(0, 10)})\n`);

interface Cfg { name: string; strat: string; p: Record<string, number> }
const CFGS: Cfg[] = [
  // --- session breakout (range asiatico -> overlap) ---
  { name: "brk chan16 rr1.5",      strat: "gold_session_breakout", p: { rr: 1.5, chanLen: 16, stepBars: 5, maxBars: 240 } },
  { name: "brk chan16 rr2",        strat: "gold_session_breakout", p: { rr: 2, chanLen: 16, stepBars: 5, maxBars: 300 } },
  { name: "brk chan16 rr3",        strat: "gold_session_breakout", p: { rr: 3, chanLen: 16, stepBars: 5, maxBars: 360 } },
  { name: "brk chan32 rr2",        strat: "gold_session_breakout", p: { rr: 2, chanLen: 32, stepBars: 5, maxBars: 360 } },
  { name: "brk chan16 rr2 ovlp",   strat: "gold_session_breakout", p: { rr: 2, chanLen: 16, stepBars: 5, maxBars: 300, tradeStart: 12, tradeEnd: 16 } },
  { name: "brk chan16 rr2 allhrs", strat: "gold_session_breakout", p: { rr: 2, chanLen: 16, stepBars: 5, maxBars: 300, tradeStart: 0, tradeEnd: 24 } },
  { name: "brk chan16 rr2 GROSS",  strat: "gold_session_breakout", p: { rr: 2, chanLen: 16, stepBars: 5, maxBars: 300, costR: 0 } },

  // --- trend M15 ---
  { name: "trend 9/21 rr1.5",      strat: "gold_trend_m15", p: { rr: 1.5, fast: 9, slow: 21, stepBars: 15, maxBars: 300 } },
  { name: "trend 9/21 rr2",        strat: "gold_trend_m15", p: { rr: 2, fast: 9, slow: 21, stepBars: 15, maxBars: 360 } },
  { name: "trend 21/55 rr2",       strat: "gold_trend_m15", p: { rr: 2, fast: 21, slow: 55, stepBars: 15, maxBars: 480 } },
  { name: "trend 9/21 rr2 allhrs", strat: "gold_trend_m15", p: { rr: 2, stepBars: 15, maxBars: 360, tradeStart: 0, tradeEnd: 24 } },
  { name: "trend 9/21 rr2 GROSS",  strat: "gold_trend_m15", p: { rr: 2, stepBars: 15, maxBars: 360, costR: 0 } },

  // --- mean reversion (Londres, sessao mais mean-revert) ---
  { name: "mr rr0.8 london",       strat: "gold_meanrev_london", p: { rr: 0.8, stepBars: 5, maxBars: 120 } },
  { name: "mr rr1 london",         strat: "gold_meanrev_london", p: { rr: 1, stepBars: 5, maxBars: 150 } },
  { name: "mr rr1.5 london",       strat: "gold_meanrev_london", p: { rr: 1.5, stepBars: 5, maxBars: 180 } },
  { name: "mr rr1 bbK2.8",         strat: "gold_meanrev_london", p: { rr: 1, bbK: 2.8, stepBars: 5, maxBars: 150 } },
  { name: "mr rr1 allday",         strat: "gold_meanrev_london", p: { rr: 1, stepBars: 5, maxBars: 150, tradeStart: 0, tradeEnd: 24 } },
  { name: "mr rr1 GROSS",          strat: "gold_meanrev_london", p: { rr: 1, stepBars: 5, maxBars: 150, costR: 0 } },

  // --- NY momentum ---
  { name: "ny rr1 f1.3",           strat: "gold_ny_momo", p: { rr: 1, forceMult: 1.3, stepBars: 5, maxBars: 120 } },
  { name: "ny rr1.5 f1.3",         strat: "gold_ny_momo", p: { rr: 1.5, forceMult: 1.3, stepBars: 5, maxBars: 150 } },
  { name: "ny rr1.5 f1.0",         strat: "gold_ny_momo", p: { rr: 1.5, forceMult: 1.0, stepBars: 5, maxBars: 150 } },
  { name: "ny rr2 f1.6",           strat: "gold_ny_momo", p: { rr: 2, forceMult: 1.6, stepBars: 5, maxBars: 180 } },
  { name: "ny rr1.5 f1.3 GROSS",   strat: "gold_ny_momo", p: { rr: 1.5, forceMult: 1.3, stepBars: 5, maxBars: 150, costR: 0 } },
];

const rows: { c: Cfg; m: ReturnType<typeof runBacktest> }[] = [];
for (const c of CFGS) {
  process.stdout.write(`running: ${c.name}                         \r`);
  const t0 = Date.now();
  const m = runBacktest(all, c.strat, { multiplier: 100, ...c.p });
  rows.push({ c, m });
  console.log(`${c.name.padEnd(24)} ${((Date.now() - t0) / 1000).toFixed(0)}s  trades=${m.trades} exp=${m.expectancy.toFixed(3)}`);
}

rows.sort((a, b) => b.m.expectancy - a.m.expectancy);
console.log("\n\n================ RANKING (expectancy liquida) ================");
console.log("config                     strat                 trades  win%   exp(R)   Racum   maxDD  wStrk  L/S   flag");
console.log("-".repeat(112));
for (const { c, m } of rows) {
  const flag = m.trades < 150 ? "baixa-amostra" : m.expectancy > 0.1 && m.rSum > 2 * m.maxDd ? "***PROMISSOR" : m.expectancy > 0.02 ? "+marginal" : m.expectancy > -0.03 ? "~breakeven" : "ruim";
  console.log(
    `${c.name.padEnd(26)} ${c.strat.padEnd(21)} ${String(m.trades).padStart(5)}  ${(m.winrate * 100).toFixed(1).padStart(5)}  ${m.expectancy.toFixed(3).padStart(6)}  ${m.rSum.toFixed(1).padStart(6)}  ${m.maxDd.toFixed(1).padStart(5)}  ${String(m.worstStreak).padStart(4)}  ${m.longs}/${m.shorts}  ${flag}`,
  );
}
