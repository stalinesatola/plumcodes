/**
 * Baixa candles M1 de frxXAUUSD (ou outro simbolo) o mais fundo que a Deriv der,
 * paginando por epoch. Salva em data/gold-m1.json (array de Candle ordenado por epoch).
 *
 * Uso: node --env-file=.env tools/gold-download.ts [symbol] [--max 120000] [--granularity 60]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { DerivClient } from "../src/deriv/client.ts";
import type { Candle } from "../src/types.ts";

const symbol = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2]! : "frxXAUUSD";
function arg(name: string, def: number): number {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
const MAX = arg("max", 150000);
const GRAN = arg("granularity", 60);
const OUT = `data/gold-${symbol}-${GRAN}.json`;

async function main() {
  const token = process.env.DERIV_TOKEN;
  if (!token) throw new Error("DERIV_TOKEN ausente");
  const client = new DerivClient({
    token,
    appId: process.env.DERIV_APP_ID || "1089",
    restBase: process.env.DERIV_REST_BASE || "https://api.derivws.com",
    mode: "demo",
    pingIntervalSec: 20,
    maxBackoffSec: 20,
  });

  let candles: Candle[] = [];
  if (existsSync(OUT)) {
    try {
      candles = JSON.parse(readFileSync(OUT, "utf8")).candles ?? [];
      console.log(`cache existente: ${candles.length} candles`);
    } catch { /* ignore */ }
  }

  await client.connect();
  // epoch (segundos) do candle mais antigo que ja temos; paginamos para tras a partir daqui.
  let cursor = candles.length ? candles[0]!.epoch - 1 : Math.floor(Date.now() / 1000);
  let emptyStreak = 0;
  for (let page = 0; page < 2000 && candles.length < MAX; page++) {
    let batch: Candle[];
    try {
      batch = await client.candlesOHLC(symbol, 1000, GRAN, String(cursor));
    } catch (e) {
      console.log(`\npagina ${page} erro: ${(e as Error).message} — retry em 3s`);
      await new Promise((r) => setTimeout(r, 3000));
      try { await client.connect(); } catch { /* */ }
      continue;
    }
    const older = batch.filter((c) => candles.length === 0 || c.epoch < candles[0]!.epoch);
    if (!older.length) {
      // buraco (fim de semana/feriado) OU fim do historico. Recua 1 dia e tenta de novo.
      emptyStreak++;
      cursor -= 86400;
      if (emptyStreak > 20) { console.log("\n>20 janelas vazias seguidas — assumindo fim do historico"); break; }
      continue;
    }
    emptyStreak = 0;
    candles = [...older, ...candles];
    cursor = older[0]!.epoch - 1;
    process.stdout.write(`\r${candles.length} candles (mais antigo: ${new Date(candles[0]!.epoch * 1000).toISOString()})   `);
  }
  process.stdout.write("\n");
  client.disconnect();

  candles.sort((a, b) => a.epoch - b.epoch);
  // dedup
  const seen = new Set<number>();
  candles = candles.filter((c) => (seen.has(c.epoch) ? false : (seen.add(c.epoch), true)));

  mkdirSync("data", { recursive: true });
  writeFileSync(OUT, JSON.stringify({ savedAt: Date.now(), symbol, granularity: GRAN, candles }));
  const first = new Date(candles[0]!.epoch * 1000).toISOString();
  const last = new Date(candles[candles.length - 1]!.epoch * 1000).toISOString();
  const spanDays = (candles[candles.length - 1]!.epoch - candles[0]!.epoch) / 86400;
  console.log(`salvo ${OUT}: ${candles.length} candles, ${first} -> ${last} (${spanDays.toFixed(1)} dias calendario)`);
}

main().catch((e) => { console.error("erro:", (e as Error).message); process.exit(1); });
