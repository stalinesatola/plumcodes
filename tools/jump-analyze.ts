/**
 * Analise da mecanica dos Jump Index (JD10, JD25, JD50, JD75, JD100).
 *
 * Uso:
 *   node --env-file=.env tools/jump-analyze.ts [--candles 15000] [--symbols JD10,JD25,JD50,JD75,JD100] [--sigma 6]
 *
 * Baixa candles M1 (60s) de cada simbolo, detecta "saltos" (candle cujo |retorno|
 * excede `sigma` desvios-padrao do retorno tipico calculado numa janela movel),
 * e mede:
 *   - intervalo entre saltos (media / mediana / desvio) -> o timing e Poisson?
 *   - distribuicao de magnitude do salto (em multiplos do desvio normal)
 *   - % de saltos para cima vs para baixo -> ha vies direcional?
 *   - o que o preco faz nos K candles DEPOIS do salto:
 *       * continua na direcao do salto (momentum) ?
 *       * reverte (mean-reversion) ?
 *       * fica de lado (range) ?
 *     medido como retorno medio pos-salto na direcao do salto, e win-rate de
 *     "seguir o salto" vs "apostar contra".
 *   - autocorrelacao do sinal do salto (salto-para-cima tende a ser seguido de
 *     outro para cima?) e previsibilidade do intervalo (o gap ate o proximo salto
 *     depende do gap anterior?).
 *
 * Nao faz trade. Nao toca em config. Cache em data/bt-cache-<sym>-60.json (mesmo
 * do backtest).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { DerivClient } from "../src/deriv/client.ts";
import type { Candle } from "../src/types.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function getCandles(client: DerivClient, symbol: string, want: number): Promise<Candle[]> {
  const cachePath = `data/bt-cache-${symbol}-60.json`;
  if (existsSync(cachePath)) {
    const c = JSON.parse(readFileSync(cachePath, "utf8"));
    if (Date.now() - c.savedAt < 30 * 60_000 && c.candles.length >= want) return c.candles.slice(-want);
  }
  let candles: Candle[] = [];
  let end = "latest";
  for (let page = 0; page < Math.ceil(want / 1000) + 2 && candles.length < want; page++) {
    const batch = await client.candlesOHLC(symbol, 1000, 60, end);
    if (!batch.length) break;
    const older = batch.filter((c) => candles.length === 0 || c.epoch < candles[0]!.epoch);
    if (!older.length) break;
    candles = [...older, ...candles];
    end = String(older[0]!.epoch - 1);
    if (batch.length < 1000) break;
  }
  try {
    mkdirSync("data", { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ savedAt: Date.now(), candles }));
  } catch {
    /* ok */
  }
  return candles;
}

function mean(a: number[]): number {
  return a.reduce((s, x) => s + x, 0) / (a.length || 1);
}
function std(a: number[]): number {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
}
function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  const n = s.length;
  if (!n) return 0;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}
function pearson(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return NaN;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    dx += (x[i]! - mx) ** 2;
    dy += (y[i]! - my) ** 2;
  }
  return num / Math.sqrt(dx * dy || 1);
}

interface Jump {
  idx: number;
  ret: number; // log-return do candle do salto
  sigmaAtSignal: number; // desvio local ANTES do salto
  mult: number; // |ret| / sigma local
  dir: 1 | -1;
}

function analyze(symbol: string, candles: Candle[], sigmaThresh: number) {
  const closes = candles.map((c) => c.close);
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i]! / closes[i - 1]!));

  const WIN = 120; // janela local (2h) para o desvio "normal"
  const jumps: Jump[] = [];
  for (let i = WIN; i < rets.length; i++) {
    // desvio dos retornos ANTERIORES, excluindo saltos ja detectados dessa janela
    const past = rets.slice(i - WIN, i).filter((r) => Math.abs(r) < 5 * (std(rets.slice(i - WIN, i)) || 1e-9));
    const s = std(past) || 1e-9;
    if (Math.abs(rets[i]!) > sigmaThresh * s) {
      // evita contar o mesmo salto 2x em candles adjacentes: exige 3 candles calmos antes
      if (jumps.length && i - jumps[jumps.length - 1]!.idx < 3) continue;
      jumps.push({
        idx: i,
        ret: rets[i]!,
        sigmaAtSignal: s,
        mult: Math.abs(rets[i]!) / s,
        dir: rets[i]! > 0 ? 1 : -1,
      });
    }
  }

  const gapsCandles: number[] = [];
  for (let k = 1; k < jumps.length; k++) gapsCandles.push(jumps[k]!.idx - jumps[k - 1]!.idx);

  const ups = jumps.filter((j) => j.dir === 1).length;
  const downs = jumps.filter((j) => j.dir === -1).length;

  // autocorrelacao do sinal do salto
  const signs = jumps.map((j) => j.dir as number);
  const acSign = pearson(signs.slice(0, -1), signs.slice(1));
  // previsibilidade do intervalo (gap[k] vs gap[k-1])
  const acGap = pearson(gapsCandles.slice(0, -1), gapsCandles.slice(1));

  // comportamento pos-salto: para varios horizontes K, retorno na direcao do salto
  const horizons = [1, 3, 5, 10, 15];
  const postRows = horizons.map((K) => {
    // mede APENAS o que acontece DEPOIS do salto: parte do close ja repreciado
    // (closes[j.idx+1]) e olha K candles a frente. >0 = continuou na direcao do salto.
    const dirRets: number[] = [];
    let cont = 0;
    let rev = 0;
    for (const j of jumps) {
      const a = closes[j.idx + 1]; // close JA COM o salto
      const b = closes[j.idx + 1 + K];
      if (a == null || b == null) continue;
      const move = Math.log(b / a) * j.dir;
      dirRets.push(move);
      if (move > 0) cont++;
      else rev++;
    }
    // normaliza o retorno pos-salto pelo tamanho tipico do proprio salto
    const jMag = mean(jumps.map((j) => Math.abs(j.ret)));
    return {
      K,
      n: dirRets.length,
      meanDirRet: mean(dirRets),
      meanDirRetInJumpUnits: mean(dirRets) / (jMag || 1),
      contPct: cont / (cont + rev || 1),
      tStat: mean(dirRets) / ((std(dirRets) || 1e-9) / Math.sqrt(dirRets.length || 1)),
    };
  });

  // "calmo entre saltos": desvio dos retornos que NAO sao proximos de um salto
  const jumpIdxSet = new Set<number>();
  for (const j of jumps) for (let d = -2; d <= 2; d++) jumpIdxSet.add(j.idx + d);
  const calmRets = rets.filter((_, i) => !jumpIdxSet.has(i));
  const acCalm = pearson(calmRets.slice(0, -1), calmRets.slice(1));

  return {
    symbol,
    candles: candles.length,
    approxDays: +(candles.length / 60 / 24).toFixed(1),
    jumps: jumps.length,
    perDayJumps: +(jumps.length / (candles.length / 60 / 24)).toFixed(2),
    gapMeanMin: +mean(gapsCandles).toFixed(1),
    gapMedianMin: +median(gapsCandles).toFixed(1),
    gapStdMin: +std(gapsCandles).toFixed(1),
    gapCvVsExp: +(std(gapsCandles) / (mean(gapsCandles) || 1)).toFixed(2), // ~1.0 => Poisson (exponencial)
    upPct: +(ups / (ups + downs || 1) * 100).toFixed(1),
    magMultMean: +mean(jumps.map((j) => j.mult)).toFixed(1),
    magMultMedian: +median(jumps.map((j) => j.mult)).toFixed(1),
    magRetPctMean: +(mean(jumps.map((j) => Math.abs(j.ret))) * 100).toFixed(3),
    acSign: +acSign.toFixed(3),
    acGap: +acGap.toFixed(3),
    acCalm: +acCalm.toFixed(3),
    post: postRows,
  };
}

async function main() {
  if (!process.env.DERIV_TOKEN) throw new Error("DERIV_TOKEN ausente");
  const want = Number(arg("candles", "15000"));
  const sigmaThresh = Number(arg("sigma", "6"));
  const symbols = arg("symbols", "JD10,JD25,JD50,JD75,JD100").split(",").map((s) => s.trim());

  const client = new DerivClient({
    token: process.env.DERIV_TOKEN,
    appId: process.env.DERIV_APP_ID || "1089",
    restBase: process.env.DERIV_REST_BASE || "https://api.derivws.com",
    mode: "demo",
    pingIntervalSec: 30,
    maxBackoffSec: 30,
  });
  await client.connect();

  const results = [];
  for (const symbol of symbols) {
    process.stdout.write(`${symbol}: baixando... `);
    let candles: Candle[];
    try {
      candles = await getCandles(client, symbol, want);
    } catch (e) {
      console.log(`erro (${(e as Error).message})`);
      continue;
    }
    console.log(`${candles.length} candles`);
    results.push(analyze(symbol, candles, sigmaThresh));
  }
  client.disconnect();

  console.log(`\n===== MECANICA DOS SALTOS (candles M1, limiar ${sigmaThresh}-sigma local) =====\n`);
  console.log(
    "sym     dias  saltos /dia  gapMed(min) gapCV  up%   magX(med)  ret%   acSign  acGap  acCalm",
  );
  console.log("-".repeat(96));
  for (const r of results) {
    console.log(
      `${r.symbol.padEnd(7)} ${String(r.approxDays).padStart(4)}  ${String(r.jumps).padStart(5)} ${String(r.perDayJumps).padStart(5)}  ${String(r.gapMedianMin).padStart(9)}  ${String(r.gapCvVsExp).padStart(5)}  ${String(r.upPct).padStart(4)}  ${String(r.magMultMedian).padStart(8)}  ${String(r.magRetPctMean).padStart(6)}  ${String(r.acSign).padStart(6)} ${String(r.acGap).padStart(6)} ${String(r.acCalm).padStart(6)}`,
    );
  }

  console.log(`\n===== COMPORTAMENTO POS-SALTO (retorno na direcao do salto) =====`);
  console.log("(+ = momentum/continuacao ; - = reversao ; contPct ~50% e |t|<2 = sem sinal)\n");
  for (const r of results) {
    console.log(`${r.symbol}  (${r.jumps} saltos)`);
    console.log("  K(min)   n   meanDirRet   emUnid.doSalto   contPct   tStat");
    for (const p of r.post) {
      console.log(
        `  ${String(p.K).padStart(5)} ${String(p.n).padStart(5)}   ${p.meanDirRet.toExponential(2).padStart(10)}   ${p.meanDirRetInJumpUnits.toFixed(3).padStart(12)}   ${(p.contPct * 100).toFixed(1).padStart(6)}%   ${p.tStat.toFixed(2).padStart(6)}`,
      );
    }
    console.log("");
  }

  console.log("Leitura:");
  console.log("- gapCV ~1.0 => intervalos exponenciais (Poisson) => timing do proximo salto NAO e previsivel.");
  console.log("- up% ~50 e acSign ~0 => direcao do salto e moeda justa => sem aposta direcional pre-salto.");
  console.log("- pos-salto: se contPct fica ~50% e |tStat|<2 em todos os horizontes => sem momentum nem reversao exploravel.");
  console.log("- acCalm ~0 => entre saltos e passeio aleatorio => nada a explorar na calmaria.");
}

main().catch((e) => {
  console.error("erro:", (e as Error).message);
  process.exit(1);
});
