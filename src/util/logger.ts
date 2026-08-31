import { appendFileSync, mkdirSync } from "node:fs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const minLevel: Level = (process.env.LOG_LEVEL as Level) || "info";

try {
  mkdirSync("data", { recursive: true });
} catch {
  /* ignore */
}

function write(level: Level, scope: string, msg: string, extra?: unknown) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const ts = new Date().toISOString();
  const line =
    `[${ts}] ${level.toUpperCase().padEnd(5)} ${scope} ${msg}` +
    (extra !== undefined ? ` ${safe(extra)}` : "");
  const sink = level === "error" || level === "warn" ? console.error : console.log;
  sink(line);
  try {
    appendFileSync("data/bot.log", line + "\n");
  } catch {
    /* ignore */
  }
}

function safe(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write("debug", scope, m, e),
    info: (m: string, e?: unknown) => write("info", scope, m, e),
    warn: (m: string, e?: unknown) => write("warn", scope, m, e),
    error: (m: string, e?: unknown) => write("error", scope, m, e),
  };
}
