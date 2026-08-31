import { readFileSync } from "node:fs";

// Carrega .env se as variaveis ainda nao estiverem no ambiente (ex: rodando via PM2
// sem --env-file). Node >= 20.12 tem process.loadEnvFile.
if (!process.env.DERIV_TOKEN) {
  try {
    (process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile(
      process.env.ENV_FILE || ".env",
    );
  } catch {
    /* sem .env — usa variaveis ja exportadas */
  }
}

import type { AppConfig } from "./types.ts";
import { DerivClient } from "./deriv/client.ts";
import { RiskManager } from "./risk/manager.ts";
import { Learner } from "./learn/learner.ts";
import { MlBridge } from "./ml/bridge.ts";
import { Bot } from "./bot.ts";
import { getStrategy } from "./strategies/index.ts";
import { createLogger } from "./util/logger.ts";

const log = createLogger("main");

function loadConfig(): AppConfig {
  const path = process.env.CONFIG_PATH || "config.json";
  const cfg = JSON.parse(readFileSync(path, "utf8")) as AppConfig;
  if (!cfg.bots?.length) throw new Error("config.json sem bots");
  for (const b of cfg.bots) getStrategy(b.strategy);
  return cfg;
}

async function main() {
  const token = process.env.DERIV_TOKEN;
  if (!token) throw new Error("DERIV_TOKEN ausente (veja .env.example)");
  const appId = process.env.DERIV_APP_ID || "1089";
  const restBase = process.env.DERIV_REST_BASE || "https://api.derivws.com";
  const accountId = process.env.DERIV_ACCOUNT_ID || undefined;

  const cfg = loadConfig();
  const enabled = cfg.bots.filter((b) => b.enabled);
  log.info(`${enabled.length} bot(s): ${enabled.map((b) => `${b.id}(${b.strategy})`).join(", ")}`);

  const client = new DerivClient({
    token,
    appId,
    restBase,
    mode: cfg.account.mode,
    accountId,
    pingIntervalSec: cfg.session.reconnect.pingIntervalSec,
    maxBackoffSec: cfg.session.reconnect.maxBackoffSec,
  });

  const risk = new RiskManager(cfg);
  const learner = new Learner(cfg);
  const ml = new MlBridge(cfg);
  ml.start();

  const bots: Bot[] = [];
  const bySymbol = new Map<string, Bot[]>();

  const acc = await client.connect();
  if (cfg.account.mode === "real" && acc.isDemo)
    throw new Error("config diz 'real' mas a conta resolvida e DEMO. Abortando.");
  if (cfg.account.mode === "demo" && !acc.isDemo)
    throw new Error("config diz 'demo' mas a conta resolvida e REAL. Abortando por seguranca.");
  log.info(`conta ${acc.accountId} ${acc.isDemo ? "DEMO" : "REAL"} saldo=${acc.balance} ${acc.currency}`);

  const balance = await client.subscribeBalance();
  risk.init(balance || acc.balance);

  for (const bc of enabled) {
    const bot = new Bot({ cfg: bc, client, risk, learner, ml, currency: cfg.account.currency });
    bots.push(bot);
    const arr = bySymbol.get(bc.symbol) ?? [];
    arr.push(bot);
    bySymbol.set(bc.symbol, arr);
  }

  for (const [symbol, group] of bySymbol) {
    try {
      const { prices, pipSize } = await client.recentTicks(symbol, 600);
      for (const b of group) b.seedPrices(prices, pipSize);
      if (group.some((b) => b.needsCandles())) {
        const ohlc = await client.candlesOHLC(symbol, 400, 60);
        for (const b of group) if (b.needsCandles()) b.seedCandles(ohlc);
      }
    } catch (e) {
      log.error(`seed ${symbol} falhou`, (e as Error).message);
    }
    await client.subscribeTicks(symbol);
  }

  client.on("tick", ({ symbol, quote, epoch, pipSize }) => {
    const group = bySymbol.get(symbol);
    if (!group) return;
    for (const b of group) b.onTick(quote, epoch, pipSize);
  });
  client.on("balance", ({ balance }) => risk.updateBalance(balance));
  client.on("contract", (poc) => {
    for (const b of bots) b.onContractUpdate(poc);
  });
  client.on("open", () => log.info("reconectado e re-subscrito"));

  const statusTimer = setInterval(() => {
    log.info("status", { risk: risk.status, bots: bots.map((b) => b.status) });
    if (risk.isHalted && bots.every((b) => !b.isOpen)) {
      log.warn("risco global HALT e sem contratos abertos — encerrando");
      shutdown(0);
    }
  }, 60_000);

  function shutdown(code: number) {
    clearInterval(statusTimer);
    learner.flush();
    ml.stop();
    client.disconnect();
    setTimeout(() => process.exit(code), 500);
  }

  process.on("SIGINT", () => {
    log.info("SIGINT — encerrando");
    shutdown(0);
  });
  process.on("SIGTERM", () => shutdown(0));
  process.on("unhandledRejection", (r) => log.error("unhandledRejection", String(r)));
}

main().catch((e) => {
  log.error("fatal", (e as Error).message);
  process.exit(1);
});
