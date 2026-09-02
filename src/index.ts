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
import { sessionOpen, sessionTick } from "./util/session.ts";
import { reconcileOpenTrades } from "./util/reconcile.ts";
import { journal } from "./util/journal.ts";
import { initTelegram, tgLifecycle, tgRisk, tgRaw } from "./util/telegram.ts";

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

  const tgCfg = cfg.alerts?.telegram;
  initTelegram({ enabled: tgCfg?.enabled ?? false, ...tgCfg });

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
  sessionOpen(balance || acc.balance);
  tgLifecycle(
    `▶️ <b>Bot iniciado</b>\n` +
      `conta ${acc.accountId} ${acc.isDemo ? "DEMO" : "REAL"} · saldo $${(balance || acc.balance).toFixed(2)}\n` +
      `bots: ${enabled.map((b) => b.id).join(", ") || "(nenhum)"}`,
  );

  for (const bc of enabled) {
    const bot = new Bot({
      cfg: bc,
      client,
      risk,
      learner,
      ml,
      currency: cfg.account.currency,
      structureCfg: cfg.structure,
    });
    bots.push(bot);
    const arr = bySymbol.get(bc.symbol) ?? [];
    arr.push(bot);
    bySymbol.set(bc.symbol, arr);
  }

  // reconcilia contratos que já estavam abertos (restart / queda de ligação) antes
  // de qualquer estratégia poder abrir posição nova
  const ownerless = await reconcileOpenTrades(client, bots).catch((e) => {
    log.error("reconciliação falhou", (e as Error).message);
    return new Set<number>();
  });

  for (const [symbol, group] of bySymbol) {
    try {
      const { prices, pipSize } = await client.recentTicks(symbol, 600);
      for (const b of group) b.seedPrices(prices, pipSize);
      if (group.some((b) => b.needsCandles())) {
        const ohlc = await client.candlesOHLC(symbol, 700, 60); // ~46 M15 p/ ADX(M15)
        for (const b of group) if (b.needsCandles()) b.seedCandles(ohlc);
      }
      // histórico H1 p/ o filtro de estrutura diária (zonas de 5-10 dias)
      if (cfg.structure?.enabled) {
        const nH1 = (cfg.structure.invalLookback ?? 240) + 40;
        const h1 = await client.candlesOHLC(symbol, nH1, 3600);
        for (const b of group) b.seedH1(h1);
      }
    } catch (e) {
      log.error(`seed ${symbol} falhou`, (e as Error).message);
    }
    // Indices OTC nao servem stream de ticks fiavel (e fecham fora de horario) →
    // poller de candles M1 a cada 20s. Forex/commodities usam o stream normal.
    if (symbol.startsWith("OTC_")) {
      const poll = async () => {
        try {
          const cs = await client.candlesOHLC(symbol, 2, 60);
          const c = cs[cs.length - 1];
          if (c) for (const b of group) b.onTick(c.close, Math.floor(Date.now() / 1000), 2);
        } catch {
          /* mercado fechado / indisponivel */
        }
      };
      const t = setInterval(poll, 20_000);
      t.unref?.();
      void poll();
    } else {
      try {
        await client.subscribeTicks(symbol);
      } catch (e) {
        log.error(`subscribeTicks ${symbol} falhou (retry em 10s)`, (e as Error).message);
        setTimeout(() => client.subscribeTicks(symbol).catch(() => void 0), 10_000);
      }
    }
  }

  client.on("tick", ({ symbol, quote, epoch, pipSize }) => {
    const group = bySymbol.get(symbol);
    if (!group) return;
    for (const b of group) b.onTick(quote, epoch, pipSize);
  });
  client.on("balance", ({ balance }) => risk.updateBalance(balance));
  client.on("contract", (poc) => {
    for (const b of bots) b.onContractUpdate(poc);
    // contrato aberto que nenhum bot adotou (ex.: estratégia removida): regista só o fecho
    if (poc?.is_sold && ownerless.has(Number(poc.contract_id))) {
      ownerless.delete(Number(poc.contract_id));
      const profit = Number(poc.profit);
      journal({
        ev: "close",
        ts: Date.now(),
        botId: "(reconciliado)",
        contractId: Number(poc.contract_id),
        tag: "adopted",
        profit,
        isWin: profit >= 0,
        rMultiple: 0,
        balanceAfter: Number(poc.balance_after ?? risk.balance),
      });
      log.info(`contrato órfão ${poc.contract_id} fechou: ${profit.toFixed(2)}`);
    }
  });
  client.on("open", () => log.info("reconectado e re-subscrito"));

  let haltedNotified = false;
  const hbMin = tgCfg?.heartbeatMinutes ?? 0;
  let hbCounter = 0;

  const statusTimer = setInterval(() => {
    sessionTick(risk.balance);
    const st = risk.status;
    const structure = bots.map((b) => b.structureSnapshot).find((s) => s) ?? null;
    log.info("status", { risk: st, bots: bots.map((b) => b.status), structure });

    if (risk.isHalted && !haltedNotified) {
      haltedNotified = true;
      tgRisk(
        `🛑 <b>Risco global HALT</b>\n${st.halted}\nP/L dia: $${st.pnlToday.toFixed(2)} (${st.pnlTodayPct.toFixed(2)}%) · saldo $${st.balance.toFixed(2)}`,
      );
    }

    if (hbMin > 0 && ++hbCounter % hbMin === 0) {
      const lines = bots.map((b) => {
        const s = b.status;
        return `• ${s.id}: ${s.wins}W/${s.losses}L  ${s.stopped ? "PARADO" : s.open ? "em posição" : "ativo"}`;
      });
      tgRaw(
        `📊 <b>Status</b> ${new Date().toISOString().slice(11, 16)} UTC\n` +
          `saldo $${st.balance.toFixed(2)} · P/L dia $${st.pnlToday.toFixed(2)} (${st.pnlTodayPct.toFixed(2)}%)\n` +
          lines.join("\n"),
      );
    }

    if (risk.isHalted && bots.every((b) => !b.isOpen)) {
      log.warn("risco global HALT e sem contratos abertos — encerrando");
      shutdown(0);
    }
  }, 60_000);

  function shutdown(code: number) {
    clearInterval(statusTimer);
    tgLifecycle(`⏹️ <b>Bot parado</b> · saldo $${risk.balance.toFixed(2)} · P/L dia $${risk.pnlToday.toFixed(2)}`);
    learner.flush();
    ml.stop();
    client.disconnect();
    setTimeout(() => process.exit(code), 1200);
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
