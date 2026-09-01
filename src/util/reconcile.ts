import { readFileSync, existsSync } from "node:fs";
import type { DerivClient } from "../deriv/client.ts";
import type { Bot } from "../bot.ts";
import { journal } from "./journal.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("reconcile");

interface JournaledOpen {
  contractId: number;
  botId: string;
  tag: string;
  symbol: string;
  ts: number;
}

/**
 * No arranque, o bot não sabe nada dos contratos que já estavam abertos (um
 * restart, ou uma queda de ligação que derrubou o stream de `proposal_open_contract`).
 * Sem isto o evento de fecho nunca é processado: o trade fica órfão no diário, o
 * P/L não conta para o stop diário e um bot pode abrir posição duplicada.
 *
 * Esta rotina cruza `data/trades.jsonl` (abertos sem fecho) com o portfólio real
 * da Deriv:
 *  - contrato ainda aberto  -> volta a segui-lo e um bot "adota-o" (fecho normal)
 *  - contrato já fechado     -> busca o P/L real no profit_table e regista o fecho
 *
 * Devolve o conjunto de contractIds abertos que nenhum bot adotou (ex.: de uma
 * estratégia removida) — o chamador regista o fecho desses no diário.
 */
export async function reconcileOpenTrades(client: DerivClient, bots: Bot[]): Promise<Set<number>> {
  const orphans = new Map<number, JournaledOpen>();
  try {
    if (existsSync("data/trades.jsonl")) {
      const opens = new Map<number, JournaledOpen>();
      const closed = new Set<number>();
      for (const ln of readFileSync("data/trades.jsonl", "utf8").trim().split("\n")) {
        let e: any;
        try {
          e = JSON.parse(ln);
        } catch {
          continue;
        }
        if (e.ev === "open") {
          opens.set(e.contractId, { contractId: e.contractId, botId: e.botId, tag: e.tag, symbol: e.symbol, ts: e.ts });
        } else if (e.ev === "close") {
          closed.add(e.contractId);
        }
      }
      for (const [id, o] of opens) if (!closed.has(id)) orphans.set(id, o);
    }
  } catch {
    /* diário ilegível — segue sem ele */
  }

  // --- contratos abertos AGORA na conta ---
  const ownerless = new Set<number>();
  let portfolio: Awaited<ReturnType<DerivClient["openContracts"]>> = [];
  try {
    portfolio = await client.openContracts();
  } catch (e) {
    log.warn(`portfólio indisponível (${(e as Error).message}) — só reconcilio pelo diário`);
  }
  if (portfolio.length) log.info(`${portfolio.length} contrato(s) aberto(s) na conta`);

  for (const c of portfolio) {
    const j = orphans.get(c.contractId);
    orphans.delete(c.contractId);
    await client.trackContract(c.contractId).catch(() => void 0);
    const sym = c.symbol.toLowerCase();
    const owner =
      (j && bots.find((b) => b.id === j.botId && !b.isOpen)) ||
      bots.find((b) => b.symbol.toLowerCase() === sym && !b.isOpen);
    if (owner && owner.adoptContract(c)) {
      log.info(`contrato ${c.contractId} (${c.symbol}) adotado por ${owner.id}`);
    } else {
      ownerless.add(c.contractId);
      log.warn(`contrato ${c.contractId} (${c.symbol}) sem bot dono — fecho será só registado no diário`);
    }
  }

  // --- órfãos que já fecharam durante o downtime ---
  if (orphans.size) {
    let table = new Map<number, { profit: number; sellTime: number }>();
    try {
      table = await client.closedContracts(300);
    } catch (e) {
      log.warn(`profit_table indisponível (${(e as Error).message}) — fecho neutro para os órfãos`);
    }
    for (const [id, o] of orphans) {
      const r = table.get(id);
      const profit = r?.profit ?? 0;
      journal({
        ev: "close",
        ts: r?.sellTime ? r.sellTime * 1000 : Date.now(),
        botId: o.botId,
        contractId: id,
        tag: o.tag,
        profit,
        isWin: profit >= 0,
        rMultiple: 0,
        balanceAfter: 0,
      });
      log.info(
        `órfão ${id} (${o.botId}/${o.tag}) reconciliado: ${r ? `P/L ${profit.toFixed(2)}` : "sem registo — fecho neutro"}`,
      );
    }
  }

  return ownerless;
}
