/**
 * Analise estatistica RIGOROSA dos contratos de DIGITO da Deriv.
 *
 * Uso:
 *   node --env-file=.env tools/digit-analyze.ts [--symbols R_100,R_75,...] [--ticks 50000] [--payouts]
 *
 * Para cada simbolo:
 *  1. Baixa >= N ticks (pagina ticks_history backwards por epoch), cache em
 *     data/digit-ticks-<sym>.json.
 *  2. Extrai o ultimo digito de cada tick na precisao pip_size do simbolo.
 *  3. Frequencia de cada digito 0-9 + qui-quadrado vs uniforme (df=9).
 *  4. Autocorrelacao dos digitos (lag 1-5); runs test de even/odd.
 *  5. Matriz de transicao 10x10 P(d_t | d_{t-1}) + qui-quadrado de independencia.
 *  6. Frequencia condicional apos rajadas (P(proximo par | k pares seguidos)).
 *  7. Se --payouts: pega payout real via getProposal (conta demo) para cada
 *     (contrato, barreira) e calcula EV = p_medido * payout - 1. Top 10.
 *
 * NAO faz trade. NAO toca em config.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { DerivClient } from "../src/deriv/client.ts";
import { lastDigit } from "../src/util/indicators.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}
const HAS_PAYOUTS = process.argv.includes("--payouts");

const ALL_SYMBOLS = [
  "R_10", "R_25", "R_50", "R_75", "R_100",
  "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V",
  "1HZ15V", "1HZ30V", "1HZ90V",
];

interface TickCache { savedAt: number; prices: number[]; times: number[]; pipSize: number; }

async function rawTicks(client: DerivClient, symbol: string, count: number, end: string) {
  const res = await client.send({ ticks_history: symbol, end, count, style: "ticks" });
  return {
    prices: (res.history?.prices ?? []).map(Number) as number[],
    times: (res.history?.times ?? []).map(Number) as number[],
    pipSize: Number(res.pip_size ?? 2),
  };
}

async function downloadTicks(client: DerivClient, symbol: string, want: number): Promise<TickCache> {
  const cachePath = `data/digit-ticks-${symbol}.json`;
  if (existsSync(cachePath)) {
    const c: TickCache = JSON.parse(readFileSync(cachePath, "utf8"));
    if (c.prices.length >= want) return c;
  }
  let prices: number[] = [];
  let times: number[] = [];
  let pipSize = 2;
  let end = "latest";
  let batch = 1000; // a nova Options API limita ticks_history a ~1000/chamada
  let fails = 0;
  let iter = 0;
  while (prices.length < want && iter++ < Math.ceil(want / 500) + 20) {
    let r;
    try {
      r = await rawTicks(client, symbol, batch, end);
    } catch (e) {
      fails++;
      const msg = (e as Error).message;
      process.stdout.write(`[retry ${fails}: ${msg.slice(0, 40)}] `);
      if (fails > 8) break;
      batch = Math.max(500, Math.floor(batch / 2));
      await new Promise((res) => setTimeout(res, 1500));
      continue;
    }
    if (!r.prices.length) break;
    pipSize = r.pipSize;
    // r vem em ordem cronologica crescente; queremos ficar so com o que e mais antigo que o inicio atual
    const cutoff = times.length ? times[0]! : Infinity;
    const keepIdx = r.times.map((t, i) => (t < cutoff ? i : -1)).filter((i) => i >= 0);
    if (!keepIdx.length) break;
    const newPrices = keepIdx.map((i) => r.prices[i]!);
    const newTimes = keepIdx.map((i) => r.times[i]!);
    prices = [...newPrices, ...prices];
    times = [...newTimes, ...times];
    end = String(newTimes[0]! - 1);
    if (iter % 10 === 0) process.stdout.write(`${prices.length} `);
    if (r.prices.length < 50) break; // fim do historico disponivel
    await new Promise((res) => setTimeout(res, 180));
  }
  const cache: TickCache = { savedAt: Date.now(), prices, times, pipSize };
  try {
    mkdirSync("data", { recursive: true });
    writeFileSync(cachePath, JSON.stringify(cache));
  } catch { /* ok */ }
  return cache;
}

// ---------- estatistica ----------

function digitsOf(prices: number[], pipSize: number): number[] {
  return prices.map((p) => lastDigit(p, pipSize));
}

/** qui-quadrado de aderencia a uniforme(10). df=9. critico: 16.92 (5%), 21.67 (1%), 27.88 (0.1%). */
function chiSquareUniform(digits: number[]) {
  const counts = new Array(10).fill(0);
  for (const d of digits) counts[d]++;
  const n = digits.length;
  const exp = n / 10;
  let chi = 0;
  for (let d = 0; d < 10; d++) chi += (counts[d] - exp) ** 2 / exp;
  return { counts, freq: counts.map((c: number) => c / n), chi, n, exp };
}

/** autocorrelacao de Pearson da serie de digitos no lag k. */
function autocorr(x: number[], lag: number): number {
  const n = x.length - lag;
  if (n < 10) return NaN;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i]!, b = x[i + lag]!;
    sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b;
  }
  const cov = sxy / n - (sx / n) * (sy / n);
  const vx = sxx / n - (sx / n) ** 2;
  const vy = syy / n - (sy / n) ** 2;
  return cov / Math.sqrt(vx * vy || 1e-12);
}

/** Wald-Wolfowitz runs test para a sequencia binaria par(1)/impar(0). retorna z. */
function runsTestZ(bits: number[]): { z: number; runs: number; expRuns: number; n1: number; n0: number } {
  let runs = 1;
  for (let i = 1; i < bits.length; i++) if (bits[i] !== bits[i - 1]) runs++;
  const n1 = bits.filter((b) => b === 1).length;
  const n0 = bits.length - n1;
  const n = bits.length;
  const expRuns = (2 * n1 * n0) / n + 1;
  const varRuns = (2 * n1 * n0 * (2 * n1 * n0 - n)) / (n * n * (n - 1));
  const z = (runs - expRuns) / Math.sqrt(varRuns || 1e-12);
  return { z, runs, expRuns, n1, n0 };
}

/** matriz de transicao 10x10 e qui-quadrado de independencia (df=81). critico 0.1%: ~124.1 */
function transitionChi(digits: number[]) {
  const trans = Array.from({ length: 10 }, () => new Array(10).fill(0));
  const rowTot = new Array(10).fill(0);
  const colTot = new Array(10).fill(0);
  let total = 0;
  for (let i = 1; i < digits.length; i++) {
    trans[digits[i - 1]!][digits[i]!]++;
    rowTot[digits[i - 1]!]++;
    colTot[digits[i]!]++;
    total++;
  }
  let chi = 0;
  for (let a = 0; a < 10; a++)
    for (let b = 0; b < 10; b++) {
      const exp = (rowTot[a] * colTot[b]) / total;
      if (exp > 0) chi += (trans[a][b] - exp) ** 2 / exp;
    }
  return { trans, rowTot, chi, total };
}

/** P(proximo par | k pares consecutivos) e idem para impar/over/under. */
function conditionalAfterStreak(bits: number[], maxK: number) {
  const rows: { k: number; nAfterEven: number; pEvenAfterEvenStreak: number; nAfterOdd: number; pEvenAfterOddStreak: number }[] = [];
  for (let k = 1; k <= maxK; k++) {
    let nE = 0, hitE = 0, nO = 0, hitO = 0;
    for (let i = k; i < bits.length; i++) {
      let allEven = true, allOdd = true;
      for (let j = i - k; j < i; j++) {
        if (bits[j] !== 1) allEven = false;
        if (bits[j] !== 0) allOdd = false;
      }
      if (allEven) { nE++; if (bits[i] === 1) hitE++; }
      if (allOdd) { nO++; if (bits[i] === 1) hitO++; }
    }
    rows.push({
      k,
      nAfterEven: nE,
      pEvenAfterEvenStreak: hitE / (nE || 1),
      nAfterOdd: nO,
      pEvenAfterOddStreak: hitO / (nO || 1),
    });
  }
  return rows;
}

// ---------- EV / payouts ----------

interface EvRow { symbol: string; contract: string; barrier: string; pWin: number; payout: number; ev: number; }

async function fetchPayout(client: DerivClient, symbol: string, contractType: string, barrier?: string): Promise<number> {
  const p = await client.getProposal({
    symbol,
    contractType,
    amount: 1,
    durationTicks: 1,
    currency: "USD",
    barrier,
  });
  return p.payout; // retorno total (stake incluso) para stake=1
}

function pWinFor(freq: number[], contract: string, barrier: number): number {
  switch (contract) {
    case "DIGITMATCH": return freq[barrier]!;
    case "DIGITDIFF": return 1 - freq[barrier]!;
    case "DIGITOVER": return freq.slice(barrier + 1).reduce((a, b) => a + b, 0);
    case "DIGITUNDER": return freq.slice(0, barrier).reduce((a, b) => a + b, 0);
    case "DIGITEVEN": return [0, 2, 4, 6, 8].reduce((a, d) => a + freq[d]!, 0);
    case "DIGITODD": return [1, 3, 5, 7, 9].reduce((a, d) => a + freq[d]!, 0);
  }
  return NaN;
}

async function main() {
  if (!process.env.DERIV_TOKEN) throw new Error("DERIV_TOKEN ausente");
  const want = Number(arg("ticks", "50000"));
  const symbols = arg("symbols", ALL_SYMBOLS.join(",")).split(",").map((s) => s.trim());

  const client = new DerivClient({
    token: process.env.DERIV_TOKEN,
    appId: process.env.DERIV_APP_ID || "1089",
    restBase: process.env.DERIV_REST_BASE || "https://api.derivws.com",
    mode: "demo",
    pingIntervalSec: 20,
    maxBackoffSec: 30,
  });
  await client.connect();

  const perSymbol: any[] = [];
  const evRows: EvRow[] = [];

  for (const symbol of symbols) {
    process.stdout.write(`\n${symbol}: baixando ticks... `);
    let cache: TickCache;
    try {
      cache = await downloadTicks(client, symbol, want);
    } catch (e) {
      console.log(`ERRO: ${(e as Error).message}`);
      continue;
    }
    const digits = digitsOf(cache.prices, cache.pipSize);
    console.log(`\n  ${digits.length} digitos (pipSize=${cache.pipSize})`);
    if (digits.length < 5000) { console.log("  amostra pequena, pulando analise"); continue; }

    const cs = chiSquareUniform(digits);
    const bits = digits.map((d) => (d % 2 === 0 ? 1 : 0));
    const acf = [1, 2, 3, 4, 5].map((k) => autocorr(digits, k));
    const runs = runsTestZ(bits);
    const tr = transitionChi(digits);
    const cond = conditionalAfterStreak(bits, 6);

    // autocorr esperado |acf| ~ 1.96/sqrt(n) para ruido
    const acfCrit = 1.96 / Math.sqrt(digits.length);

    perSymbol.push({ symbol, n: digits.length, cs, acf, acfCrit, runs, tr, cond });

    console.log(`  freq %: ${cs.freq.map((f: number, d: number) => `${d}:${(f * 100).toFixed(2)}`).join("  ")}`);
    console.log(`  qui-quadrado uniforme = ${cs.chi.toFixed(2)}  (df=9; critico 16.9@5%, 27.9@0.1%)  ${cs.chi > 27.88 ? "<<< SIGNIFICATIVO 0.1%" : cs.chi > 16.92 ? "< signif 5%" : "nao rejeita uniforme"}`);
    console.log(`  autocorr lags 1-5: ${acf.map((a) => a.toFixed(4)).join("  ")}  (|crit|=${acfCrit.toFixed(4)})`);
    console.log(`  runs test even/odd: z=${runs.z.toFixed(3)}  (runs=${runs.runs} vs esperado ${runs.expRuns.toFixed(0)})  ${Math.abs(runs.z) > 3.29 ? "<<< SIGNIF 0.1%" : Math.abs(runs.z) > 1.96 ? "< signif 5%" : "sem sequencias anomalas"}`);
    console.log(`  transicao 10x10 qui-quad independencia = ${tr.chi.toFixed(1)}  (df=81; critico ~124.1@0.1%, ~113.1@1%)  ${tr.chi > 124.1 ? "<<< SIGNIF" : "nao rejeita independencia"}`);
    console.log(`  P(par | k pares seguidos):  ${cond.map((r) => `k=${r.k}:${(r.pEvenAfterEvenStreak * 100).toFixed(1)}%(n=${r.nAfterEven})`).join("  ")}`);

    if (HAS_PAYOUTS) {
      process.stdout.write("  payouts reais... ");
      const jobs: { contract: string; barrier?: string; bnum: number }[] = [];
      for (let b = 0; b <= 9; b++) { jobs.push({ contract: "DIGITMATCH", barrier: String(b), bnum: b }); jobs.push({ contract: "DIGITDIFF", barrier: String(b), bnum: b }); }
      for (let b = 0; b <= 8; b++) jobs.push({ contract: "DIGITOVER", barrier: String(b), bnum: b });
      for (let b = 1; b <= 9; b++) jobs.push({ contract: "DIGITUNDER", barrier: String(b), bnum: b });
      jobs.push({ contract: "DIGITEVEN", bnum: -1 });
      jobs.push({ contract: "DIGITODD", bnum: -1 });
      for (const j of jobs) {
        try {
          const payout = await fetchPayout(client, symbol, j.contract, j.barrier);
          const pWin = pWinFor(cs.freq, j.contract, j.bnum);
          evRows.push({ symbol, contract: j.contract, barrier: j.barrier ?? "-", pWin, payout, ev: pWin * payout - 1 });
        } catch (e) {
          process.stdout.write(`[${j.contract}/${j.barrier} err] `);
        }
        await new Promise((res) => setTimeout(res, 120));
      }
      console.log("ok");
    }
  }

  client.disconnect();

  if (evRows.length) {
    evRows.sort((a, b) => b.ev - a.ev);
    console.log(`\n===== TOP 15 EV (EV = P_medido(win) * payout_total - 1 ; EV>0 => edge) =====`);
    console.log("sym       contrato     barr   P(win)   payout   EV");
    console.log("-".repeat(60));
    for (const r of evRows.slice(0, 15)) {
      console.log(`${r.symbol.padEnd(9)} ${r.contract.padEnd(11)}  ${String(r.barrier).padStart(3)}   ${(r.pWin * 100).toFixed(2).padStart(6)}%  ${r.payout.toFixed(4).padStart(7)}  ${(r.ev * 100).toFixed(2).padStart(7)}%`);
    }
    console.log(`\nPIOR 5:`);
    for (const r of evRows.slice(-5)) {
      console.log(`${r.symbol.padEnd(9)} ${r.contract.padEnd(11)}  ${String(r.barrier).padStart(3)}   ${(r.pWin * 100).toFixed(2).padStart(6)}%  ${r.payout.toFixed(4).padStart(7)}  ${(r.ev * 100).toFixed(2).padStart(7)}%`);
    }
    const positives = evRows.filter((r) => r.ev > 0);
    console.log(`\n${positives.length} combinacoes com EV > 0 de ${evRows.length} testadas.`);
    if (positives.length) {
      // quantos desvios-padrao a freq medida esta da uniforme para o melhor?
      for (const r of positives.slice(0, 10)) {
        const sym = perSymbol.find((s) => s.symbol === r.symbol);
        console.log(`  ${r.symbol} ${r.contract} ${r.barrier}: EV=${(r.ev * 100).toFixed(2)}%  (qui-quad do simbolo=${sym?.cs.chi.toFixed(1)})`);
      }
    }
    try {
      writeFileSync("data/digit-ev-table.json", JSON.stringify(evRows, null, 2));
      console.log("\ntabela completa: data/digit-ev-table.json");
    } catch { /* ok */ }
  }

  try {
    writeFileSync("data/digit-analyze-summary.json", JSON.stringify(perSymbol.map((s) => ({
      symbol: s.symbol, n: s.n, chiUniform: s.cs.chi, freq: s.cs.freq,
      autocorr: s.acf, acfCrit: s.acfCrit, runsZ: s.runs.z, transitionChi: s.tr.chi,
    })), null, 2));
  } catch { /* ok */ }

  console.log(`\nLeitura:`);
  console.log(`- qui-quadrado < 16.9 => distribuicao de digitos indistinguivel de uniforme => sem vies de digito.`);
  console.log(`- |autocorr| < crit e |runs z| < 1.96 => digitos sao i.i.d. => o passado nao prediz o proximo digito.`);
  console.log(`- transicao qui-quad < 113 => P(d|d_ant) = P(d) => matriz de transicao nao ajuda.`);
  console.log(`- se nenhum EV > 0 com a freq MEDIDA (que ja embute qualquer vies real): SEM EDGE, definitivo.`);
}

main().catch((e) => { console.error("erro:", (e as Error).message); process.exit(1); });
