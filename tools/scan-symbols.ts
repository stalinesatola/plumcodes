/**
 * Escaneia os índices sintéticos da Deriv que suportam multiplicadores e roda as
 * estratégias de candle (m1_scalp, m1_amd) em cada um, rankeando por expectancy.
 *
 * Uso:
 *   node --env-file=.env tools/scan-symbols.ts [--candles 4000] [--strategies m1_scalp,m1_amd] [--group vol|jump|boomcrash|step|all]
 *
 * Baixa candles M1 de cada símbolo (com cache em data/), simula, e imprime uma
 * tabela. Não é prova — é um filtro para escolher em qual símbolo focar o
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
};
GROUPS.all = [...GROUPS.vol, ...GROUPS.jump, ...GROUPS.boomcrash, ...GROUPS.step];

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
  for (let page = 0; page < Math.ceil(want / 1000) + 1 && candles.length < want; page++) {
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

async function main() {
  if (!process.env.DERIV_TOKEN) throw new Error("DERIV_TOKEN ausente");
  const want = Number(arg("candles", "4000"));
  const strategies = arg("strategies", "m1_scalp,m1_amd").split(",");
  const group = arg("group", "vol");
  const symbols = GROUPS[group] ?? GROUPS.vol!;

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
    process.stdout.write(`${candles.length} candles, simulando `);
    for (const st of strategies) {
      const m = runBacktest(candles, st.trim(), { multiplier: 100, rr: st.includes("amd") ? 1.5 : 2 });
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
