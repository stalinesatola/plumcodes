import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

/**
 * Liga/desliga bots EM TEMPO REAL, sem reiniciar o processo, via
 * data/bot-enabled.json:
 *
 *   { "<botId>": true | false, "_resume": { "<botId>": <ts> } }
 *
 * Chave ausente = ligado (default). Desligar só impede NOVAS entradas — uma
 * posição já aberta segue o seu curso (trailing / maxHold). Cada vez que o
 * monitor LIGA um bot ([b]), grava `_resume[id] = agora`; o bot usa isso para
 * sair de um estado PARADO (breaker diário). O bot relê a cada ~4s.
 */
const PATH = "data/bot-enabled.json";

interface Ctrl {
  [id: string]: boolean | Record<string, number> | undefined;
  _resume?: Record<string, number>;
}

let cache: Ctrl = {};
let cacheAt = 0;

function load(): Ctrl {
  try {
    return JSON.parse(readFileSync(PATH, "utf8")) as Ctrl;
  } catch {
    return {};
  }
}

function refresh(): void {
  if (Date.now() - cacheAt < 4000) return;
  cache = load();
  cacheAt = Date.now();
}

/** O bot `id` está ligado? (default: sim). */
export function botEnabled(id: string): boolean {
  refresh();
  return cache[id] !== false;
}

/** Timestamp do último "resume" pedido pelo monitor para o bot `id` (0 = nunca). */
export function resumeRequestedAt(id: string): number {
  refresh();
  return cache._resume?.[id] ?? 0;
}

/** Grava o estado ligado/desligado do bot `id`. Ligar também pede um "resume". */
export function setBotEnabled(id: string, on: boolean): void {
  const obj = load();
  obj[id] = on;
  if (on) {
    const r = (obj._resume ?? {}) as Record<string, number>;
    r[id] = Date.now();
    obj._resume = r;
  }
  try {
    mkdirSync("data", { recursive: true });
    writeFileSync(PATH, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
  cache = obj;
  cacheAt = Date.now();
}

/** Mapa id -> ligado (para o monitor). */
export function allBotEnabled(): Record<string, boolean> {
  refresh();
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(cache)) {
    if (k === "_resume") continue;
    out[k] = v !== false;
  }
  return out;
}
