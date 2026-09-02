import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

/**
 * Liga/desliga bots EM TEMPO REAL, sem reiniciar o processo, via
 * data/bot-enabled.json  ({ "<botId>": true | false }).
 *
 * Chave ausente = ligado (default). Desligar só impede NOVAS entradas — uma
 * posição já aberta segue o seu curso (trailing / maxHold). O monitor escreve
 * este arquivo pela tecla [b]; o bot lê a cada ~4s.
 */
const PATH = "data/bot-enabled.json";

let cache: Record<string, boolean> = {};
let cacheAt = 0;

function refresh(): void {
  if (Date.now() - cacheAt < 4000) return;
  try {
    cache = JSON.parse(readFileSync(PATH, "utf8")) as Record<string, boolean>;
  } catch {
    cache = {};
  }
  cacheAt = Date.now();
}

/** O bot `id` está ligado? (default: sim). */
export function botEnabled(id: string): boolean {
  refresh();
  return cache[id] !== false;
}

/** Grava o estado ligado/desligado do bot `id`. */
export function setBotEnabled(id: string, on: boolean): void {
  let obj: Record<string, boolean> = {};
  try {
    obj = JSON.parse(readFileSync(PATH, "utf8")) as Record<string, boolean>;
  } catch {
    /* arquivo novo */
  }
  obj[id] = on;
  try {
    mkdirSync("data", { recursive: true });
    writeFileSync(PATH, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
  cache = obj;
  cacheAt = Date.now();
}

/** Mapa completo (para o monitor). */
export function allBotEnabled(): Record<string, boolean> {
  refresh();
  return { ...cache };
}
