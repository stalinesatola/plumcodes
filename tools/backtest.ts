/**
 * Backtester offline para estrategias baseadas em candle (kind: "candle").
 *
 * Uso:
 *   node --env-file=.env tools/backtest.ts <strategyName> <symbol> [--candles N] [--granularity 60] [--param k=v ...]
 *
 * Ex:
 *   node --env-file=.env tools/backtest.ts m1_scalp R_75 --candles 5000 --param multiplier=100 --param rr=2
 *
 * O que faz:
 *  1. Baixa N candles historicos da Deriv (via a mesma conexao da nova Options API).
 *  2. Roda o `evaluate` da estrategia barra a barra (candleClosed=true a cada fechamento).
 *  3. Simula o resultado do contrato:
 *     - MULTUP/MULTDOWN: caminha pelos candles seguintes; ganha se o high/low bate o
 *       take-profit (rr * stopDistance) antes do stop (stopDistance). Empate no candle
 *       que toca os dois -> conta como perda (conservador).
 *     - CALL/PUT: compara o close depois de `durationTicks` candles (aproximacao grosseira).
 *  4. Reporta: trades, winrate, expectancy (em R), PnL liquido aprox, max drawdown,
 *     maior sequencia de perdas.
 *
 * AVISO: isto NAO substitui teste em conta demo. Nao modela spread/comissao com
 * precisao, nem o preco tick-a-tick dentro do candle. Serve para comparar variantes
 * de parametros e descartar estrategias claramente ruins ANTES de arriscar dinheiro.
 * Estrategias de digito (kind "digits") nao sao backtestaveis aqui — o resultado
 * depende do RNG e do digito exato liquidado; use forward-test em demo.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { DerivClient } from "../src/deriv/client.ts";
import { getStrategy } from "../src/strategies/index.ts";
import { runBacktest } from "./_sim.ts";
import type { Candle } from "../src/types.ts";

interface Args {
  strategy: string;
  symbol: string;
  candles: number;
  granularity: number;
  params: Record<string, number>;
  file: string;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  if (a.length < 2) {
    console.error("uso: node tools/backtest.ts <strategyName> <symbol> [--candles N] [--granularity S] [--param k=v]");
    process.exit(1);
  }
  const out: Args = { strategy: a[0]!, symbol: a[1]!, candles: 3000, granularity: 60, params: {}, file: "" };
  for (let i = 2; i < a.length; i++) {
    if (a[i] === "--candles") out.candles = Number(a[++i]);
    else if (a[i] === "--file") out.file = String(a[++i]);
    else if (a[i] === "--granularity") out.granularity = Number(a[++i]);
    else if (a[i] === "--param") {
      const [k, v] = String(a[++i]).split("=");
      if (k) out.params[k] = Number(v);
    }
  }
  return out;
}

// janela deslizante: a estrategia so precisa das ~N ultimas barras. Sem isto o
// backtest fica O(n^2) e trava em series grandes.
async function main() {
  const args = parseArgs();
  const strat = getStrategy(args.strategy);
  if (strat.kind !== "candle") {
    console.error(`Estrategia "${args.strategy}" e kind="${strat.kind}". O backtester so cobre kind="candle".`);
    process.exit(1);
  }

  const token = process.env.DERIV_TOKEN;
  if (!token) throw new Error("DERIV_TOKEN ausente");
  const client = new DerivClient({
    token,
    appId: process.env.DERIV_APP_ID || "1089",
    restBase: process.env.DERIV_REST_BASE || "https://api.derivws.com",
    mode: "demo",
    pingIntervalSec: 30,
    maxBackoffSec: 30,
  });
  const want = Math.min(args.candles, 500000);
  const cachePath = `data/bt-cache-${args.symbol}-${args.granularity}.json`;
  let candles: Candle[] = [];

  if (args.file) {
    const j = JSON.parse(readFileSync(args.file, "utf8"));
    const all: Candle[] = j.candles ?? j;
    all.sort((a, b) => a.epoch - b.epoch);
    candles = all.slice(-want);
    console.log(`arquivo ${args.file}: ${candles.length} candles (de ${all.length})`);
  }

  const cacheFresh =
    !args.file &&
    existsSync(cachePath) &&
    Date.now() - JSON.parse(readFileSync(cachePath, "utf8")).savedAt < 30 * 60_000;
  if (cacheFresh) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (cached.candles.length >= want) {
      candles = cached.candles.slice(-want);
      console.log(`usando cache: ${candles.length} candles (${cachePath})`);
    }
  }

  if (candles.length === 0) {
    await client.connect();
    console.log(`baixando ~${want} candles de ${args.symbol} (${args.granularity}s)...`);
    const maxPages = Math.ceil(want / 1000) + 6; // folga: a Deriv devolve paginas curtas no meio do historico
    let end = "latest";
    let dry = 0;
    for (let page = 0; page < maxPages && candles.length < want; page++) {
      const batch = await client.candlesOHLC(args.symbol, 1000, args.granularity, end).catch(() => []);
      const older = batch.filter((c) => candles.length === 0 || c.epoch < candles[0]!.epoch);
      // so para quando NAO vem nada mais antigo 2x seguidas (fim real do historico)
      if (older.length === 0) {
        if (++dry >= 2) break;
        continue;
      }
      dry = 0;
      candles = [...older, ...candles];
      end = String(older[0]!.epoch - 1);
      process.stdout.write(`\r  ${candles.length} candles...`);
    }
    process.stdout.write("\n");
    client.disconnect();
    try {
      mkdirSync("data", { recursive: true });
      writeFileSync(cachePath, JSON.stringify({ savedAt: Date.now(), candles }));
    } catch {
      /* ok */
    }
  }
  console.log(`${candles.length} candles. Rodando ${args.strategy}...`);

  // Serie H1 REAL p/ o contexto de timeframe alto (btc-h1, ilf_liquidity_sweep).
  // A Deriv so serve ~4000 velas M1 de cripto, entao reamostrar M1 nao chega p/
  // EMA50/200 no H1 — baixa H1 direto (vai bem mais fundo). So quando a serie
  // principal e sub-horaria e a estrategia usa H1.
  let h1: Candle[] = [];
  const HTF_STRATS = new Set(["gold_h1_trend", "ilf_liquidity_sweep"]);
  if (args.granularity < 3600 && HTF_STRATS.has(args.strategy) && !args.file) {
    const h1Cache = `data/bt-cache-${args.symbol}-3600.json`;
    if (existsSync(h1Cache)) {
      try {
        h1 = JSON.parse(readFileSync(h1Cache, "utf8")).candles ?? [];
      } catch {
        /* ok */
      }
    }
    if (h1.length < 2000) {
      await client.connect();
      console.log(`baixando serie H1 de ${args.symbol} p/ contexto HTF...`);
      let end = "latest";
      let dryH1 = 0;
      for (let page = 0; page < 16 && h1.length < 8000; page++) {
        const batch = await client.candlesOHLC(args.symbol, 1000, 3600, end).catch(() => []);
        const older = batch.filter((c) => h1.length === 0 || c.epoch < h1[0]!.epoch);
        if (older.length === 0) {
          if (++dryH1 >= 2) break;
          continue;
        }
        dryH1 = 0;
        h1 = [...older, ...h1];
        end = String(older[0]!.epoch - 1);
      }
      client.disconnect();
      try {
        writeFileSync(h1Cache, JSON.stringify({ savedAt: Date.now(), candles: h1 }));
      } catch {
        /* ok */
      }
    }
    console.log(`  ${h1.length} velas H1 p/ contexto.`);
  }

  const m = runBacktest(candles, args.strategy, args.params, h1.length ? h1 : undefined);
  const robust = m.rSum > 2 * m.maxDd && m.trades >= 50;
  console.log("\n===== RESULTADO (aproximado) =====");
  console.log(`estrategia      ${args.strategy}  ${args.symbol}`);
  console.log(`params          ${JSON.stringify(args.params)}`);
  console.log(`trades          ${m.trades}  (long ${m.longs} / short ${m.shorts})`);
  console.log(`winrate         ${(m.winrate * 100).toFixed(1)}%`);
  console.log(`expectancy      ${m.expectancy.toFixed(3)} R por trade  (>0 = positivo)`);
  console.log(`R acumulado     ${m.rSum.toFixed(1)} R`);
  console.log(`max drawdown    ${m.maxDd.toFixed(1)} R`);
  console.log(`pior sequencia  ${m.worstStreak} perdas seguidas`);
  console.log(`breakeven wr    ${(m.breakevenWr * 100).toFixed(1)}%`);
  let veredito: string;
  if (m.trades < 30) veredito = "AMOSTRA INSUFICIENTE — mais candles ou params menos restritivos";
  else if (m.expectancy > 0.1 && robust) veredito = "PROMISSOR — validar em demo";
  else if (m.expectancy > 0.0) veredito = "MARGINAL — ajustar params (1 por vez), rodar de novo";
  else veredito = "RUIM — nao usar";
  console.log(`veredito        ${veredito}`);
}

main().catch((e) => {
  console.error("erro:", (e as Error).message);
  process.exit(1);
});
