import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

/**
 * Estado DIÁRIO de cada bot persistido em data/bot-day-state.json.
 *
 * Sem isto, todo restart (pm2 / tecla [k]) zerava os contadores do dia
 * (dayWins/dayLosses/dayTrades), o P/L do bot e o flag `stopped` — ou seja,
 * reiniciar burlava os limites diários (`daily.*`, `botStopLossUsd`,
 * `botTakeProfitUsd`). Agora um restart no mesmo dia UTC retoma a disciplina.
 */
const PATH = "data/bot-day-state.json";

export interface BotDay {
  dayWins: number;
  dayLosses: number;
  dayTrades: number;
  realizedPnl: number;
  stopped: boolean;
  stopReason: string;
}

interface DayFile {
  dayKey: string;
  bots: Record<string, BotDay>;
}

const utcDay = (): string => new Date().toISOString().slice(0, 10);

function read(): DayFile {
  try {
    const f = JSON.parse(readFileSync(PATH, "utf8")) as DayFile;
    if (f?.dayKey === utcDay() && f.bots) return f;
  } catch {
    /* sem arquivo / dia diferente */
  }
  return { dayKey: utcDay(), bots: {} };
}

/** Estado do dia UTC de hoje para o bot `id`, ou null se não houver. */
export function loadBotDay(id: string): BotDay | null {
  return read().bots[id] ?? null;
}

/** Persiste o estado do dia do bot `id`. */
export function saveBotDay(id: string, s: BotDay): void {
  try {
    mkdirSync("data", { recursive: true });
    const f = read();
    f.dayKey = utcDay();
    f.bots[id] = s;
    writeFileSync(PATH, JSON.stringify(f));
  } catch {
    /* ignore */
  }
}
