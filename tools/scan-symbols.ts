/**
 * Escaneia símbolos da Deriv que suportam multiplicadores e roda cada estratégia
 * de candle em cada um, rankeando por expectancy / taxa de acerto.
 *
 * Uso:
 *   node --env-file=.env tools/scan-symbols.ts [--candles 20000] [--strategies a,b,c]
 *       [--group forex|crypto|vol|jump|boomcrash|step|all] [--symbols frxEURUSD,frxGBPUSD]
 *
 * Default: group=forex, todas as estratégias de candle/multiplicador relevantes.
 * Baixa M1 (+ H1 p/ estratégias de timeframe alto) com cache em data/, simula, e
 * imprime a tabela. Não é prova — é um filtro para escolher ONDE fazer o
 * forward-test em conta demo.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { DerivClient } from "../src/deriv/client.ts";
import { runBacktest } from "./_sim.ts";
import type { Candle } from "../src/types.ts";

const GROUPS: Record<string, string[]> = {
  vol: ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V"],
  jump: ["JD10", "JD25", "JD50", "JD75", "JD100"],
  boomcrash: ["BOOM300N", "BOOM500", "BOOM1000", "CRASH300N", "CRASH500", "CRASH1000"],
  step: ["stpRNG", "stpRNG2", "stpRNG3"],
  // majors de forex com MULTUP/MULTDOWN na Deriv (NZDUSD só tem CALL/PUT — fora)
  forex: [
    "frxEURUSD",
    "frxGBPUSD",
    "frxUSDJPY",
    "frxAUDUSD",
    "frxUSDCAD",
    "frxUSDCHF",
    "frxEURGBP",
    "frxEURJPY",
    "frxGBPJPY",
  ],
  crypto: ["cryBTCUSD"],
};
GROUPS.all = [...GROUPS.vol, ...GROUPS.jump, ...GROUPS.boomcrash, ...GROUPS.step];

// estratégias de candle/multiplicador que fazem sentido em forex/cripto
const DEFAULT_STRATS =
  "gold_ny_momo,gold_meanrev_london,gold_trend_m15,gold_session_breakout,gold_trend_scalp,gold_h1_trend,crypto_ema_rsi_trend,ilf_liquidity_sweep";
const HTF_STRATS = new Set(["gold_h1_trend", "ilf_liquidity_sweep"]);

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

async function getCandles(
  client: DerivClient,
  symbol: string,
  want: number,
  granSec = 60,
): Promise<Candle[]> {
  const cachePath = `data/bt-cache-${symbol}-${granSec}.json`;
  if (existsSync(cachePath)) {
    const c = JSON.parse(readFileSync(cachePath, "utf8"));
    if (Date.now() - c.savedAt < 30 * 60_000 && c.candles.length >= want) return c.candles.slice(-want);
  }
  let candles: Candle[] = [];
  let end = "latest";
  let dry = 0;
  // sem parar em batch<1000: a Deriv devolve páginas curtas no meio do histórico
  for (let page = 0; page < Math.ceil(want / 1000) + 8 && candles.length < want; page++) {
    const batch = await client.candlesOHLC(symbol, 1000, granSec, end).catch(() => []);
    const older = batch.filter((c) => candles.length === 0 || c.epoch < candles[0]!.epoch);
    if (!older.length) {
      if (++dry >= 2) break;
      continue;
    }
    dry = 0;
    candles = [...older, ...candles];
    end = String(older[0]!.epoch - 1);
  }
  try {
    mkdirSync("data", { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ savedAt: Date.now(), candles }));
  } catch {
    /* ok */
  }
  return candles;
}

async function main() {
  if (!process.env.DERIV_TOKEN) throw new Error("DERIV_TOKEN ausente");
  const want = Number(arg("candles", "20000"));
  const strategies = arg("strategies", DEFAULT_STRATS).split(",");
  const group = arg("group", "forex");
  const symbols = arg("symbols", "") ? arg("symbols", "").split(",") : (GROUPS[group] ?? GROUPS.forex!);
  const needH1 = strategies.some((s) => HTF_STRATS.has(s.trim()));

  const client = new DerivClient({
    token: process.env.DERIV_TOKEN,
    appId: process.env.DERIV_APP_ID || "1089",
    restBase: process.env.DERIV_REST_BASE || "https://api.derivws.com",
    mode: "demo",
    pingIntervalSec: 30,
    maxBackoffSec: 30,
  });
  await client.connect();

  const rows: { symbol: string; strategy: string; m: ReturnType<typeof runBacktest> }[] = [];
  for (const symbol of symbols) {
    process.stdout.write(`${symbol}: baixando... `);
    let candles: Candle[];
    try {
      candles = await getCandles(client, symbol, want);
    } catch (e) {
      console.log(`erro (${(e as Error).message})`);
      continue;
    }
    let h1: Candle[] = [];
    if (needH1) {
      try {
        h1 = await getCandles(client, symbol, 8000, 3600);
      } catch {
        /* ok */
      }
    }
    process.stdout.write(`${candles.length} candles${h1.length ? ` +${h1.length} H1` : ""}, simulando `);
    for (const st of strategies) {
      const m = runBacktest(candles, st.trim(), { multiplier: 100, rr: 2 }, h1.length ? h1 : undefined);
      rows.push({ symbol, strategy: st.trim(), m });
      process.stdout.write(".");
    }
    console.log(" ok");
  }
  client.disconnect();

  rows.sort((a, b) => b.m.expectancy - a.m.expectancy);

  console.log(`\n===== RANKING (${want} candles M1, ~${Math.round((want / 60 / 24) * 10) / 10} dias) =====`);
  console.log("símbolo      estratégia   trades  winrate  expectancy(R)  Racum   maxDD   L/S");
  console.log("-".repeat(82));
  for (const { symbol, strategy, m } of rows) {
    const flag = m.trades < 30 ? " (amostra baixa)" : m.expectancy > 0.1 && m.rSum > 2 * m.maxDd ? " ***" : m.expectancy > 0 ? " +" : "";
    console.log(
      `${symbol.padEnd(12)} ${strategy.padEnd(11)} ${String(m.trades).padStart(5)}  ${(m.winrate * 100).toFixed(1).padStart(6)}%  ${m.expectancy.toFixed(3).padStart(11)}  ${m.rSum.toFixed(0).padStart(5)}  ${m.maxDd.toFixed(0).padStart(5)}   ${m.longs}/${m.shorts}${flag}`,
    );
  }
  console.log("\n*** = promissor (expectancy > 0.1 R e Racum > 2x drawdown)   + = expectancy positiva mas fraca");
  console.log("Lembre: amostra < ~100 trades não é conclusiva. Isto só aponta ONDE fazer forward-test em demo.");
}

main().catch((e) => {
  console.error("erro:", (e as Error).message);
  process.exit(1);
});
