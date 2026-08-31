import { appendFileSync, mkdirSync } from "node:fs";

/** Diário de operações append-only em data/trades.jsonl (uma linha JSON por evento).
 *  Consumido pela TUI (tools/dashboard.ts) para posições abertas + histórico. */
export type TradeEvent =
  | {
      ev: "open";
      ts: number;
      botId: string;
      strategy: string;
      symbol: string;
      tag: string;
      contractId: number;
      dir: "up" | "down";
      entry: number;
      stake: number;
      multiplier: number;
      stopDist: number;
      slPrice: number;
      tpPrice: number;
    }
  | {
      ev: "close";
      ts: number;
      botId: string;
      contractId: number;
      tag: string;
      profit: number;
      isWin: boolean;
      rMultiple: number;
      balanceAfter: number;
    };

export function journal(e: TradeEvent): void {
  try {
    mkdirSync("data", { recursive: true });
    appendFileSync("data/trades.jsonl", JSON.stringify(e) + "\n");
  } catch {
    /* ignore */
  }
}
