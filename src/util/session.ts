import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

/** Estado de sessão persistido em data/session.json — consumido pela TUI para
 *  mostrar saldo de abertura da sessão atual e de fecho da sessão anterior. */
const PATH = "data/session.json";

export interface SessionState {
  openBalance: number;
  openTs: number;
  lastBalance: number;
  lastTs: number;
  prevOpenBalance: number | null;
  prevCloseBalance: number | null;
  prevOpenTs: number | null;
  prevCloseTs: number | null;
}

function save(s: SessionState): void {
  try {
    mkdirSync("data", { recursive: true });
    writeFileSync(PATH, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** Chamado no arranque: arquiva a sessão anterior e abre uma nova. */
export function sessionOpen(balance: number): void {
  let prev: Partial<SessionState> = {};
  try {
    prev = JSON.parse(readFileSync(PATH, "utf8"));
  } catch {
    /* sem sessão anterior */
  }
  save({
    openBalance: balance,
    openTs: Date.now(),
    lastBalance: balance,
    lastTs: Date.now(),
    prevOpenBalance: prev.openBalance ?? null,
    prevCloseBalance: prev.lastBalance ?? null,
    prevOpenTs: prev.openTs ?? null,
    prevCloseTs: prev.lastTs ?? null,
  });
}

/** Chamado no heartbeat: atualiza o último saldo conhecido. */
export function sessionTick(balance: number): void {
  try {
    const s = JSON.parse(readFileSync(PATH, "utf8")) as SessionState;
    s.lastBalance = balance;
    s.lastTs = Date.now();
    save(s);
  } catch {
    /* ignore */
  }
}
