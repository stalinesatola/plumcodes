/**
 * dashboard.ts — monitor TUI estilo btop para o Deriv Quant Research Framework.
 *
 *   node --env-file=.env tools/dashboard.ts [--symbols frxXAUUSD] [--once]
 *
 * Painéis (cantos arredondados, medidores em gradiente, gráfico braille):
 *  - account   saldo, P/L do dia dos bots vs stop/take, abertura da sessão,
 *              fecho da sessão anterior
 *  - risk+market  estado do risco + horário do mercado (aberto/fechado, aberto
 *                 há X, fecha em Y)
 *  - bots      por bot: janela UTC, estado (ANALISANDO / EM POSIÇÃO / FORA DA
 *              JANELA / PARADO / mercado fechado), há quanto analisa, W/L, R
 *  - price · active positions · history · learning · log
 *
 * Atalhos: [q] sair · [r] atualizar · [a] alternar conta demo/real (a real pede
 * confirmação; o monitor NUNCA opera, só observa).
 *
 * `--once` renderiza um quadro no stdout e sai. Sem dependências além de `ws`.
 */
process.env.LOG_SILENT = "1"; // silencia o logger do DerivClient (antes do import)
import { readFileSync, existsSync } from "node:fs";
import { DerivClient } from "../src/deriv/client.ts";
import { getStrategy } from "../src/strategies/index.ts";
import { SESSIONS, sessionOpen, nextOpenMs, closeInMs, GOLD_SYMBOL } from "../src/util/markets.ts";

// ------------------------------------------------------------------ ANSI / tema
const ESC = "\x1b[";
const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const bgRed = `${ESC}48;2;150;58;58m`;

const T = {
  border: rgb(64, 74, 92),
  borderHi: rgb(110, 130, 160),
  title: rgb(125, 207, 255),
  text: rgb(197, 200, 198),
  dim: rgb(107, 116, 128),
  green: rgb(158, 206, 106),
  yellow: rgb(224, 175, 104),
  red: rgb(247, 118, 142),
  mag: rgb(187, 154, 247),
  blue: rgb(122, 162, 247),
  cyan: rgb(125, 207, 255),
};
// gradiente do gráfico (cyan -> azul -> magenta), estilo btop-CPU
const GRAD: Array<[number, number, number]> = [
  [125, 207, 255],
  [122, 162, 247],
  [154, 132, 240],
  [187, 154, 247],
  [214, 140, 200],
];
const gradAt = (t: number): string => {
  const x = Math.max(0, Math.min(1, t)) * (GRAD.length - 1);
  const i = Math.floor(x);
  const c = GRAD[Math.min(i, GRAD.length - 1)]!;
  return rgb(c[0], c[1], c[2]);
};

const out = (s: string) => process.stdout.write(s);
const at = (row: number, col: number) => `${ESC}${row};${col}H`;
const stripLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, w: number) => {
  const l = stripLen(s);
  return l >= w ? s : s + " ".repeat(w - l);
};
const clip = (s: string, w: number): string => {
  if (stripLen(s) <= w) return s;
  let vis = 0;
  let res = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        res += m[0];
        i += m[0].length - 1;
        continue;
      }
    }
    if (vis >= w - 1) {
      res += "…";
      break;
    }
    res += s[i];
    vis++;
  }
  return res;
};

// ------------------------------------------------------------------ primitivas
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
function box(r: Rect, title: string, accent = T.title): string[] {
  const lines: string[] = [];
  const top =
    T.border +
    "╭─" +
    accent +
    BOLD +
    title +
    RESET +
    T.border +
    "─".repeat(Math.max(0, r.w - stripLen(title) - 4)) +
    "─╮" +
    RESET;
  lines.push(at(r.y, r.x) + top);
  for (let i = 1; i < r.h - 1; i++) {
    lines.push(at(r.y + i, r.x) + T.border + "│" + RESET + " ".repeat(r.w - 2) + T.border + "│" + RESET);
  }
  lines.push(at(r.y + r.h - 1, r.x) + T.border + "╰" + "─".repeat(r.w - 2) + "╯" + RESET);
  return lines;
}
const put = (r: Rect, row: number, col: number, s: string): string =>
  at(r.y + 1 + row, r.x + 2 + col) + clip(s, r.w - 4 - col);

/** medidor em gradiente, largura w, 0..1 */
function meter(frac: number, w: number, label = ""): string {
  const f = Math.max(0, Math.min(1, frac));
  const cells = w - stripLen(label) - (label ? 1 : 0);
  const filled = Math.round(f * cells);
  let bar = "";
  for (let i = 0; i < cells; i++) {
    if (i < filled) bar += gradAt(i / Math.max(1, cells - 1)) + "█";
    else bar += T.border + "─";
  }
  return (label ? T.dim + label + " " : "") + bar + RESET;
}

/** gráfico braille: série -> `height` linhas de `width` chars (2 subcols x 4 dots por char) */
const BR_DOTS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];
function brailleGraph(series: number[], width: number, height: number): string[] {
  const rows: string[][] = Array.from({ length: height }, () => Array(width).fill(0));
  if (series.length < 2) return rows.map((r) => T.dim + "·".repeat(width) + RESET);
  const need = width * 2;
  const data = series.slice(-need);
  let lo = Math.min(...data);
  let hi = Math.max(...data);
  if (hi - lo < 1e-9) hi = lo + 1;
  const totalDots = height * 4;
  for (let i = 0; i < data.length; i++) {
    const col = Math.floor(i / 2);
    const sub = i % 2;
    if (col >= width) break;
    const norm = (data[i]! - lo) / (hi - lo);
    const dots = Math.max(1, Math.round(norm * totalDots));
    for (let d = 0; d < dots; d++) {
      const fromBottom = d;
      const charRow = height - 1 - Math.floor(fromBottom / 4);
      const dotRow = 3 - (fromBottom % 4);
      if (charRow >= 0 && charRow < height) rows[charRow]![col]! |= BR_DOTS[dotRow]![sub]!;
    }
  }
  return rows.map((r, ri) => {
    const t = 1 - ri / Math.max(1, height - 1);
    let line = gradAt(t);
    for (const code of r) line += code ? String.fromCharCode(0x2800 + code) : " ";
    return line + RESET;
  });
}

// ------------------------------------------------------------------ modelo
interface Model {
  connected: boolean;
  accountId: string;
  isDemo: boolean;
  currency: string;
  balance: number;
  startBalance: number;
  startedAt: number;
  prices: Map<string, number[]>;
  lastTick: Map<string, number>;
  logLines: string[];
  learn: any;
  trades: { open: OpenPos[]; closed: ClosedTrade[] };
  market: { open: boolean; live: boolean; intervals: Array<{ open: number; close: number }>; note: string } | null;
  goldDay: { open: number; prevClose: number } | null; // vela D1 do XAUUSD: abertura de hoje + fecho de ontem
  session: any;
  botStatus: { ts: number; bots: any[]; risk: any } | null;
  monitorMode: "demo" | "real";
  confirmReal: boolean;
  priceIdx: number;
  showStats: boolean; // overlay [t] — estatística dos últimos 100 trades
  disconnectedSince: number; // ts do início da queda de ligação (0 = ligado)
  err: string;
}

/** Agrega estatística de uma lista de trades fechados (usado pelo overlay [t]). */
function tradeStats(cl: ClosedTrade[]) {
  const n = cl.length;
  const wins = cl.filter((c) => c.isWin);
  const losses = cl.filter((c) => !c.isWin);
  const sumR = cl.reduce((s, c) => s + c.r, 0);
  const sumProfit = cl.reduce((s, c) => s + c.profit, 0);
  const grossWin = wins.reduce((s, c) => s + Math.max(0, c.profit), 0);
  const grossLoss = Math.abs(losses.reduce((s, c) => s + Math.min(0, c.profit), 0));
  const avgWinR = wins.length ? wins.reduce((s, c) => s + c.r, 0) / wins.length : 0;
  const avgLossR = losses.length ? losses.reduce((s, c) => s + c.r, 0) / losses.length : 0;
  // maior sequência e drawdown em R sobre a curva acumulada
  let peak = 0, cum = 0, maxDD = 0, streak = 0, worstStreak = 0, bestStreak = 0, curW = 0;
  for (const c of cl) {
    cum += c.r;
    peak = Math.max(peak, cum);
    maxDD = Math.min(maxDD, cum - peak);
    if (c.isWin) {
      curW = curW > 0 ? curW + 1 : 1;
      bestStreak = Math.max(bestStreak, curW);
    } else {
      curW = curW < 0 ? curW - 1 : -1;
      worstStreak = Math.min(worstStreak, curW);
    }
    streak = curW;
  }
  const byTag = new Map<string, { n: number; w: number; r: number }>();
  for (const c of cl) {
    const t = byTag.get(c.tag) ?? { n: 0, w: 0, r: 0 };
    t.n++; t.w += c.isWin ? 1 : 0; t.r += c.r;
    byTag.set(c.tag, t);
  }
  const byBot = new Map<string, { n: number; w: number; r: number }>();
  for (const c of cl) {
    const b = byBot.get(c.botId) ?? { n: 0, w: 0, r: 0 };
    b.n++; b.w += c.isWin ? 1 : 0; b.r += c.r;
    byBot.set(c.botId, b);
  }
  return {
    n,
    winRate: n ? wins.length / n : 0,
    sumR,
    expectancyR: n ? sumR / n : 0,
    sumProfit,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgWinR,
    avgLossR,
    maxDD,
    bestStreak,
    worstStreak: Math.abs(worstStreak),
    curStreak: streak,
    best: cl.reduce((a, c) => (c.r > (a?.r ?? -Infinity) ? c : a), null as ClosedTrade | null),
    worst: cl.reduce((a, c) => (c.r < (a?.r ?? Infinity) ? c : a), null as ClosedTrade | null),
    firstTs: n ? cl[0]!.ts : 0,
    lastTs: n ? cl[n - 1]!.ts : 0,
    byTag: [...byTag.entries()].sort((a, b) => b[1].r - a[1].r),
    byBot: [...byBot.entries()].sort((a, b) => b[1].r - a[1].r),
  };
}

function loadSession(): any {
  try {
    return JSON.parse(readFileSync("data/session.json", "utf8"));
  } catch {
    return null;
  }
}
function parseBotStatus(lines: string[]): { ts: number; bots: any[]; risk: any } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const mt = lines[i]!.match(/^\[([^\]]+)\][^{]*main status (\{.*\})\s*$/);
    if (mt) {
      try {
        const o = JSON.parse(mt[2]!);
        return { ts: Date.parse(mt[1]!), bots: o.bots ?? [], risk: o.risk ?? {} };
      } catch {
        /* linha truncada */
      }
    }
  }
  return null;
}
function fmtShort(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(mm).padStart(2, "0")}m` : `${mm}m${String(s % 60).padStart(2, "0")}s`;
}
function marketSince(iv: Array<{ open: number; close: number }>): { open: boolean; sinceMs: number; untilMs: number; label: string } {
  const now = Date.now() / 1000;
  for (const x of iv) {
    if (now >= x.open && now < x.close) {
      return { open: true, sinceMs: (now - x.open) * 1000, untilMs: (x.close - now) * 1000, label: "" };
    }
  }
  const next = iv.filter((x) => x.open > now).sort((a, b) => a.open - b.open)[0];
  return {
    open: false,
    sinceMs: 0,
    untilMs: next ? (next.open - now) * 1000 : 0,
    label: next ? `abre em ${fmtShort((next.open - now) * 1000)}` : "sem sessão agendada",
  };
}

function loadLearn(): any {
  try {
    if (existsSync("data/learn-state.json")) return JSON.parse(readFileSync("data/learn-state.json", "utf8"));
  } catch {
    /* ignore */
  }
  return null;
}
function loadLog(n: number): string[] {
  try {
    if (!existsSync("data/bot.log")) return [];
    return readFileSync("data/bot.log", "utf8").trim().split("\n").slice(-n);
  } catch {
    return [];
  }
}
function loadRiskCfg(): any {
  try {
    return JSON.parse(readFileSync(process.env.CONFIG_PATH || "config.json", "utf8"));
  } catch {
    return { risk: {}, bots: [] };
  }
}

interface OpenPos {
  botId: string;
  tag: string;
  dir: "up" | "down";
  entry: number;
  stopDist: number;
  slPrice: number;
  tpPrice: number;
  ts: number;
}
interface ClosedTrade {
  ts: number;
  botId: string;
  symbol?: string;
  tag: string;
  profit: number;
  isWin: boolean;
  r: number;
  dir?: "up" | "down";
  entry?: number;
}
function loadTrades(): { open: OpenPos[]; closed: ClosedTrade[] } {
  const open: OpenPos[] = [];
  const closed: ClosedTrade[] = [];
  try {
    if (!existsSync("data/trades.jsonl")) return { open, closed };
    const lines = readFileSync("data/trades.jsonl", "utf8").trim().split("\n").slice(-800);
    const opens = new Map<number, any>();
    const closedIds = new Set<number>();
    for (const ln of lines) {
      let e: any;
      try {
        e = JSON.parse(ln);
      } catch {
        continue;
      }
      if (e.ev === "open") opens.set(e.contractId, e);
      else if (e.ev === "close") {
        closedIds.add(e.contractId);
        const o = opens.get(e.contractId);
        closed.push({
          ts: e.ts,
          botId: e.botId,
          symbol: o?.symbol,
          tag: e.tag,
          profit: e.profit,
          isWin: e.isWin,
          r: e.rMultiple ?? 0,
          dir: o?.dir,
          entry: o?.entry,
        });
      }
    }
    for (const [id, o] of opens) {
      if (closedIds.has(id)) continue;
      open.push({
        botId: o.botId,
        tag: o.tag,
        dir: o.dir,
        entry: o.entry,
        stopDist: o.stopDist,
        slPrice: o.slPrice,
        tpPrice: o.tpPrice,
        ts: o.ts,
      });
    }
  } catch {
    /* ignore */
  }
  return { open, closed };
}

// ------------------------------------------------------------------ render
function fmtMoney(n: number, cur: string): string {
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;
}
function humanDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m ${String(s % 60).padStart(2, "0")}s`;
}

function render(m: Model, cfg: any): void {
  const W = Math.max(80, process.stdout.columns || Number(process.env.COLUMNS) || 100);
  const H = Math.max(24, process.stdout.rows || Number(process.env.LINES) || 30);
  const buf: string[] = [`${ESC}H`]; // home (não limpa: menos flicker)

  // header
  const clock = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const downFor = m.disconnectedSince ? fmtShort(Date.now() - m.disconnectedSince) : "";
  const conn = m.connected
    ? T.green + "● connected"
    : m.err
      ? T.red + "● " + m.err + (downFor ? ` (${downFor})` : "")
      : T.yellow + "● reconnecting" + (downFor ? ` ${downFor}` : "") + `${T.dim} · [r] agora`;
  const head = `${T.cyan}${BOLD}deriv quant research${RESET}${T.dim} · monitor${RESET}   ${conn}${RESET}${T.dim}   up ${humanDur(Date.now() - m.startedAt)}   ${clock}${RESET}`;
  buf.push(at(1, 2) + pad(clip(head, W - 3), W - 3));

  const symbols = [...m.prices.keys()];
  const sym0 = symbols.length ? symbols[m.priceIdx % symbols.length]! : "frxXAUUSD";
  const top = 3;
  const PANEL_H = 11;
  const colW = Math.floor((W - 3) / 3);
  const nowUtcH = new Date().getUTCHours() + new Date().getUTCMinutes() / 60;

  // pnl do dia = realizado pelos nossos bots (do bot status), não delta de saldo
  const dayPnl = m.botStatus?.risk?.pnlToday ?? 0;
  const dayPnlPct = m.botStatus?.risk?.pnlTodayPct ?? 0;
  const slPct = cfg.risk?.dailyStopLossPct ?? 10;
  const tpPct = cfg.risk?.dailyTakeProfitPct ?? 15;
  const towardStop = Math.max(0, -dayPnlPct) / slPct;
  const towardTake = Math.max(0, dayPnlPct) / tpPct;

  // ---- ACCOUNT ----
  const acc: Rect = { x: 2, y: top, w: colW - 1, h: PANEL_H };
  buf.push(...box(acc, " account ", T.cyan));
  const modeBadge = m.monitorMode === "real" ? `${bgRed}${T.text} REAL ${RESET}` : `${T.blue}DEMO${RESET}`;
  buf.push(put(acc, 0, 0, `${T.dim}${m.accountId}${RESET}  ${modeBadge}`));
  buf.push(put(acc, 1, 0, `${T.text}${BOLD}${fmtMoney(m.balance, m.currency)}${RESET}`));
  const pnlCol = dayPnl > 0 ? T.green : dayPnl < 0 ? T.red : T.dim;
  buf.push(put(acc, 2, 0, `${T.dim}P/L dia ${pnlCol}${dayPnl >= 0 ? "+" : ""}${dayPnl.toFixed(2)} (${dayPnlPct >= 0 ? "+" : ""}${dayPnlPct.toFixed(2)}%)${RESET}`));
  buf.push(put(acc, 3, 0, meter(towardStop, acc.w - 4, `${T.red}stop ${slPct}%${RESET}`)));
  buf.push(put(acc, 4, 0, meter(towardTake, acc.w - 4, `${T.green}take ${tpPct}%${RESET}`)));
  // linha 5: saldo — abertura da sessão (compacto)
  if (m.session && m.session.openBalance != null) {
    const so = m.session.openBalance;
    const ago = m.session.openTs ? fmtShort(Date.now() - m.session.openTs) : "?";
    const sd = m.balance - so;
    const sdc = sd >= 0 ? T.green : T.red;
    buf.push(put(acc, 5, 0, `${T.dim}saldo abriu ${T.text}${so.toFixed(2)}${T.dim} há ${ago} ${sdc}${sd >= 0 ? "+" : ""}${sd.toFixed(2)}${RESET}`));
  } else {
    buf.push(put(acc, 5, 0, `${T.dim}saldo: sessão não iniciada${RESET}`));
  }
  // linhas 6-7: OURO — vela D1 (abertura de hoje, fecho de ontem)
  const gd = m.goldDay;
  const gcur = m.lastTick.get(GOLD_SYMBOL) ?? (m.prices.get(GOLD_SYMBOL)?.slice(-1)[0] ?? 0);
  if (gd) {
    const gp = gd.open ? ((gcur - gd.open) / gd.open) * 100 : 0;
    const gpc = gp >= 0 ? T.green : T.red;
    buf.push(put(acc, 6, 0, `${T.dim}ouro D1 ${T.text}${gd.open.toFixed(2)}${T.dim} → ${T.text}${gcur ? gcur.toFixed(2) : "—"} ${gpc}${gp >= 0 ? "+" : ""}${gp.toFixed(2)}%${RESET}`));
    const yd = gd.prevClose ? ((gd.open - gd.prevClose) / gd.prevClose) * 100 : 0;
    const ydc = yd >= 0 ? T.green : T.red;
    buf.push(put(acc, 7, 0, `${T.dim}ontem fechou ${T.text}${gd.prevClose.toFixed(2)} ${ydc}${yd >= 0 ? "+" : ""}${yd.toFixed(2)}%${RESET}`));
  } else {
    buf.push(put(acc, 6, 0, `${T.dim}ouro D1: (carregando…)${RESET}`));
  }

  // ---- RISK + MARKET ----
  const risk: Rect = { x: 2 + colW, y: top, w: colW - 1, h: PANEL_H };
  buf.push(...box(risk, " risk + market ", T.mag));
  const stale = m.botStatus ? Date.now() - m.botStatus.ts > 180_000 : true;
  const halted = m.botStatus?.risk?.halted;
  const state = halted ? T.red + "HALT" : towardTake >= 1 ? T.green + "TARGET" : m.botStatus && !stale ? T.green + "OK" : T.yellow + "BOT OFFLINE?";
  buf.push(put(risk, 0, 0, `${T.dim}estado${RESET}  ${BOLD}${state}${RESET}${halted ? ` ${T.red}${String(halted).slice(0, 18)}${RESET}` : ""}`));
  buf.push(put(risk, 1, 0, `${T.dim}floor ${T.text}${cfg.risk?.hardFloorBalance ?? 5}${T.dim}  streak→pause ${T.text}${cfg.risk?.globalLossStreakPause ?? 8}${T.dim}  loss ${T.text}${m.botStatus?.risk?.lossStreak ?? 0}${RESET}`));
  // mercado
  const mkt = m.market;
  const ms = mkt ? marketSince(mkt.intervals) : null;
  buf.push(put(risk, 3, 0, `${T.dim}${sym0} mercado${RESET}`));
  if (mkt && ms) {
    if (ms.open) {
      buf.push(put(risk, 4, 0, `  ${T.green}${BOLD}ABERTO${RESET}${T.dim}  aberto há ${T.text}${fmtShort(ms.sinceMs)}${RESET}`));
      buf.push(put(risk, 5, 0, `  ${T.dim}fecha em ${T.yellow}${fmtShort(ms.untilMs)}${RESET}`));
    } else {
      buf.push(put(risk, 4, 0, `  ${T.red}${BOLD}FECHADO${RESET}${T.dim}  ${ms.label}${RESET}`));
    }
    if (mkt.note) buf.push(put(risk, 6, 0, `  ${T.dim}${clip(mkt.note, risk.w - 8)}${RESET}`));
  } else {
    buf.push(put(risk, 4, 0, `  ${T.dim}(carregando horário…)${RESET}`));
  }

  // ---- SESSIONS — relógio das 5 praças (contexto p/ o XAUUSD) ----
  const strat: Rect = { x: 2 + colW * 2, y: top, w: W - 3 - colW * 2, h: PANEL_H };
  buf.push(...box(strat, " sessions ", T.blue));
  const now = new Date();
  const sessRows = SESSIONS.map((s) => ({
    s,
    open: sessionOpen(s, now),
    closeMs: closeInMs(s, now),
    openMs: nextOpenMs(s, now),
  }));
  const overlap = sessRows.filter((r) => r.open).length >= 2;
  sessRows.sort((a, b) => (a.open === b.open ? (a.open ? a.closeMs - b.closeMs : a.openMs - b.openMs) : a.open ? -1 : 1));

  let sr = 0;
  for (const r of sessRows) {
    if (sr >= strat.h - 3) break;
    const isNYorLDN = r.open && (r.s.key === "london" || r.s.key === "newyork");
    const dotc = r.open ? (isNYorLDN && overlap ? T.yellow + "◆" : T.green + "●") : T.dim + "○";
    const timing = r.open
      ? `${T.green}aberto${RESET} ${T.dim}fecha ${fmtShort(r.closeMs)}`
      : `${T.dim}fechado · abre ${fmtShort(r.openMs)}`;
    buf.push(put(strat, sr++, 0, `${dotc}${RESET} ${T.text}${pad(r.s.label, 11)}${RESET}${timing}${RESET}`));
  }
  const bothLN =
    sessRows.find((r) => r.s.key === "london")?.open && sessRows.find((r) => r.s.key === "newyork")?.open;
  buf.push(put(strat, strat.h - 3, 0, `${T.border}${"─".repeat(strat.w - 4)}${RESET}`));
  const gcl = m.trades.closed;
  const gw = gcl.filter((c) => c.isWin).length;
  const gR = gcl.reduce((s, c) => s + c.r, 0);
  buf.push(
    put(
      strat,
      strat.h - 2,
      0,
      bothLN
        ? `${T.yellow}◆ overlap London+NY — vol. máx. do ouro${RESET}`
        : gcl.length
          ? `${T.dim}XAUUSD: ${T.text}${gcl.length}t${T.dim} · ${T.text}${((gw / gcl.length) * 100).toFixed(0)}%${T.dim} · ${gR >= 0 ? T.green : T.red}${gR >= 0 ? "+" : ""}${gR.toFixed(1)}R${RESET}`
          : `${T.dim}XAUUSD: sem operações fechadas ainda${RESET}`,
    ),
  );

  const sym = sym0;
  const ser = m.prices.get(sym) ?? [];
  const last = m.lastTick.get(sym) ?? (ser.length ? ser[ser.length - 1]! : 0);
  const dec = 2; // XAUUSD

  // ---- PRICE (largo) ----
  const pTop = top + PANEL_H;
  const avail = H - pTop - 2; // -2: reserva a linha do rodapé
  const priceH = Math.max(9, Math.min(16, Math.floor(avail * 0.42)));
  const pr: Rect = { x: 2, y: pTop, w: W - 3, h: priceH };
  const first = ser.length ? ser[0]! : last;
  const chg = last - first;
  const chgPct = first ? (chg / first) * 100 : 0;
  const cc = chg > 0 ? T.green : chg < 0 ? T.red : T.dim;
  const hi = ser.length ? Math.max(...ser) : last;
  const lo = ser.length ? Math.min(...ser) : last;
  buf.push(
    ...box(
      pr,
      ` ${sym}  ${T.text}${last.toFixed(dec)}${RESET}  ${cc}${chg >= 0 ? "▲" : "▼"} ${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(3)}%${RESET} `,
      T.cyan,
    ),
  );
  brailleGraph(ser, pr.w - 4, pr.h - 2).forEach((ln, gi) => buf.push(put(pr, gi, 0, ln)));
  buf.push(put(pr, 0, pr.w - 24, `${T.dim}hi ${hi.toFixed(dec)}${RESET}`));
  buf.push(put(pr, pr.h - 3, pr.w - 24, `${T.dim}lo ${lo.toFixed(dec)}${RESET}`));
  buf.push(put(pr, pr.h - 3, 0, `${T.dim}${ser.length} ticks${RESET}`));
  // marcadores de posição aberta no gráfico
  m.trades.open.slice(0, pr.h - 4).forEach((o, oi) => {
    const arrow = o.dir === "up" ? T.green + "▲ LONG " : T.red + "▼ SHORT";
    buf.push(put(pr, 1 + oi, pr.w - 24, `${arrow} @ ${o.entry.toFixed(dec)}${RESET}`));
  });

  // ---- POSITIONS + HISTORY ----
  const midY = pTop + priceH;
  const midH = Math.min(9, Math.max(6, H - midY - 7));
  const posR: Rect = { x: 2, y: midY, w: Math.floor((W - 3) * 0.52), h: midH };
  buf.push(...box(posR, " active positions ", T.green));
  if (m.trades.open.length === 0) {
    buf.push(put(posR, 0, 0, `${T.dim}nenhuma posição aberta${RESET}`));
    buf.push(put(posR, 1, 0, `${T.dim}(estratégias operam em janelas UTC — ver bots)${RESET}`));
  } else {
    buf.push(put(posR, 0, 0, `${T.dim}${pad("dir", 7)}${pad("entry", 11)}${pad("now / R", 13)}${pad("SL", 10)}${pad("TP", 10)}age${RESET}`));
    m.trades.open.slice(0, posR.h - 3).forEach((o, oi) => {
      const dcol = o.dir === "up" ? T.green : T.red;
      const uR = o.stopDist > 0 ? ((last - o.entry) / o.stopDist) * (o.dir === "up" ? 1 : -1) : 0;
      const rcol = uR >= 0 ? T.green : T.red;
      const age = humanDur(Date.now() - o.ts).replace(/^0h /, "");
      buf.push(
        put(
          posR,
          oi + 1,
          0,
          `${dcol}${pad(o.dir === "up" ? "LONG" : "SHORT", 7)}${RESET}${T.text}${pad(o.entry.toFixed(dec), 11)}${RESET}` +
            `${rcol}${pad(`${uR >= 0 ? "+" : ""}${uR.toFixed(2)}R`, 13)}${RESET}` +
            `${T.dim}${pad(o.slPrice.toFixed(dec), 10)}${pad(o.tpPrice.toFixed(dec), 10)}${age}${RESET}`,
        ),
      );
    });
  }

  const histR: Rect = { x: 2 + posR.w + 1, y: midY, w: W - 3 - posR.w - 1, h: midH };
  buf.push(...box(histR, " history ", T.blue));
  const cl = m.trades.closed;
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayR = cl.filter((c) => new Date(c.ts).toISOString().slice(0, 10) === todayKey).reduce((s, c) => s + c.r, 0);
  const totR = cl.reduce((s, c) => s + c.r, 0);
  const wins = cl.filter((c) => c.isWin).length;
  const wr = cl.length ? (wins / cl.length) * 100 : 0;
  buf.push(
    put(
      histR,
      0,
      0,
      `${T.dim}trades ${T.text}${cl.length}${T.dim}  win ${T.text}${wr.toFixed(0)}%${T.dim}  ` +
        `today ${todayR >= 0 ? T.green : T.red}${todayR >= 0 ? "+" : ""}${todayR.toFixed(1)}R${T.dim}  ` +
        `all ${totR >= 0 ? T.green : T.red}${totR >= 0 ? "+" : ""}${totR.toFixed(1)}R${RESET}`,
    ),
  );
  let cumR = totR;
  const rows = cl.slice(-(histR.h - 3)).reverse();
  rows.forEach((c, ci) => {
    const hhmm = new Date(c.ts).toISOString().slice(11, 16);
    const mk = c.isWin ? T.green + "W" : T.red + "L";
    const rc = c.r >= 0 ? T.green : T.red;
    buf.push(
      put(
        histR,
        ci + 1,
        0,
        `${T.dim}${hhmm}${RESET} ${mk}${RESET} ${T.text}${pad(c.tag, 10)}${RESET}` +
          `${rc}${pad(`${c.r >= 0 ? "+" : ""}${c.r.toFixed(2)}R`, 9)}${RESET}${T.dim}Σ ${cumR.toFixed(1)}${RESET}`,
      ),
    );
    cumR -= c.r;
  });
  if (cl.length === 0) buf.push(put(histR, 1, 0, `${T.dim}sem operações fechadas ainda${RESET}`));

  // ---- LEARNING + LOG ----
  const bY = midY + midH;
  const bH = Math.max(4, H - bY - 2); // -2: rodapé
  const learnR: Rect = { x: 2, y: bY, w: Math.floor((W - 3) * 0.4), h: bH };
  buf.push(...box(learnR, " learning ", T.mag));
  if (m.learn && m.learn.bots && Object.keys(m.learn.bots).length) {
    let lr = 0;
    for (const [bid, b] of Object.entries<any>(m.learn.bots)) {
      if (lr >= learnR.h - 2) break;
      buf.push(
        put(learnR, lr++, 0, `${T.text}${bid}${RESET} ${T.dim}tuning ${(b.tuning ?? 0).toFixed(2)}${b.onProbation ? T.yellow + " ·probation" : ""}${RESET}`),
      );
      for (const [tag, a] of Object.entries<any>(b.arms ?? {})) {
        if (lr >= learnR.h - 2) break;
        const w = a.recent?.length ? a.recent.reduce((x: number, y: number) => x + y, 0) / a.recent.length : 0;
        buf.push(put(learnR, lr++, 1, `${T.dim}${pad(tag, 9)}${RESET}${meter(w, 12)} ${T.dim}${a.trades ?? 0}t${RESET}`));
      }
    }
  } else {
    buf.push(put(learnR, 0, 0, `${T.dim}sem data/learn-state.json ainda${RESET}`));
    buf.push(put(learnR, 1, 0, `${T.dim}(o bot ainda não fechou trades)${RESET}`));
  }

  const logR: Rect = { x: 2 + learnR.w + 1, y: bY, w: W - 3 - learnR.w - 1, h: bH };
  buf.push(...box(logR, " log ", T.yellow));
  const lines = m.logLines.length ? m.logLines : ["(data/bot.log vazio — inicie o bot: pm2 start ecosystem.config.cjs)"];
  lines.slice(-(logR.h - 2)).forEach((ln, li) => {
    let c = T.dim;
    if (/WIN|TARGET|connected|autenticado/i.test(ln)) c = T.green;
    else if (/LOSS|HALT|fatal|erro|PARADO/i.test(ln)) c = T.red;
    else if (/ENTRAR|WARN|reconect/i.test(ln)) c = T.yellow;
    buf.push(put(logR, li, 0, c + ln.replace(/\x1b\[[0-9;]*m/g, "") + RESET));
  });

  // ---- rodapé / atalhos ----
  const acctLabel =
    m.monitorMode === "real" ? `${T.red}REAL${RESET}` : `${T.blue}DEMO${RESET}`;
  const mktLbl = m.market
    ? ms?.open
      ? `${T.green}${sym0} ABERTO${RESET}${T.dim} · fecha ${fmtShort(ms.untilMs)}`
      : `${T.red}${sym0} FECHADO${RESET}${T.dim} · ${ms?.label ?? ""}`
    : `${T.dim}mercado …`;
  const foot = m.confirmReal
    ? `${bgRed}${T.text} conectar à CONTA REAL? [s] sim  [n] não ${RESET}`
    : m.showStats
      ? `${T.dim}[t] fechar   [q] sair   estatística dos últimos 100 trades${RESET}`
      : `${T.dim}[q] sair   [r] reconectar/atualizar   [t] stats 100   [a] conta ${acctLabel}${T.dim}   ${RESET}${mktLbl}${RESET}`;
  buf.push(at(H, 2) + pad(clip(foot, W - 3), W - 3));

  if (m.showStats) renderStats(m, W, H, buf);

  out(buf.join(""));
}

/** Overlay [t] — painel central com a estatística dos últimos 100 trades fechados. */
function renderStats(m: Model, W: number, H: number, buf: string[]): void {
  const cl = m.trades.closed.slice(-100);
  const bw = Math.min(84, W - 6);
  const bh = Math.min(30, H - 4);
  const bx = Math.floor((W - bw) / 2) + 1;
  const by = Math.floor((H - bh) / 2) + 1;
  const r: Rect = { x: bx, y: by, w: bw, h: bh };
  // fundo opaco
  for (let i = 0; i < bh; i++) buf.push(at(by + i, bx) + " ".repeat(bw));
  buf.push(...box(r, ` últimos ${cl.length} trades `, T.mag));
  if (cl.length === 0) {
    buf.push(put(r, 0, 0, `${T.dim}nenhum trade fechado ainda (data/trades.jsonl vazio)${RESET}`));
    return;
  }
  const s = tradeStats(cl);
  const per = (x: number) => `${(x * 100).toFixed(1)}%`;
  const sr = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`;
  const col = (x: number) => (x >= 0 ? T.green : T.red);
  const span = `${new Date(s.firstTs).toISOString().slice(5, 16)} → ${new Date(s.lastTs).toISOString().slice(5, 16)} UTC`;
  let y = 0;
  buf.push(put(r, y++, 0, `${T.dim}período  ${T.text}${span}${RESET}`));
  y++;
  const L = (label: string, val: string) => put(r, y++, 0, `${T.dim}${pad(label, 22)}${RESET}${val}`);
  buf.push(L("win rate", `${T.text}${per(s.winRate)}${T.dim}  (${cl.filter((c) => c.isWin).length}W / ${cl.filter((c) => !c.isWin).length}L)${RESET}`));
  buf.push(L("total", `${col(s.sumR)}${sr(s.sumR)}${RESET}${T.dim}  ·  ${col(s.sumProfit)}${s.sumProfit >= 0 ? "+" : ""}${s.sumProfit.toFixed(2)} USD${RESET}`));
  buf.push(L("expectancy / trade", `${col(s.expectancyR)}${sr(s.expectancyR)}${RESET}`));
  buf.push(L("profit factor", `${col(s.profitFactor - 1)}${s.profitFactor === Infinity ? "∞" : s.profitFactor.toFixed(2)}${RESET}`));
  buf.push(L("média ganho / perda", `${T.green}${sr(s.avgWinR)}${RESET}${T.dim} / ${RESET}${T.red}${sr(s.avgLossR)}${RESET}`));
  buf.push(L("max drawdown", `${T.red}${s.maxDD.toFixed(2)}R${RESET}`));
  buf.push(L("melhor / pior seq.", `${T.green}${s.bestStreak}W${RESET}${T.dim} / ${RESET}${T.red}${s.worstStreak}L${RESET}${T.dim}  (agora ${s.curStreak >= 0 ? s.curStreak + "W" : -s.curStreak + "L"})${RESET}`));
  if (s.best && s.worst) {
    buf.push(L("melhor / pior trade", `${T.green}${sr(s.best.r)} ${s.best.tag}${RESET}${T.dim} / ${RESET}${T.red}${sr(s.worst.r)} ${s.worst.tag}${RESET}`));
  }
  y++;
  buf.push(put(r, y++, 0, `${T.title}por setup${RESET}`));
  for (const [tag, t] of s.byTag.slice(0, 5)) {
    buf.push(put(r, y++, 0, `${T.dim}${pad(tag, 16)}${RESET}${pad(`${t.n}t`, 6)}${T.dim}${pad(per(t.w / t.n), 8)}${RESET}${col(t.r)}${sr(t.r)}${RESET}`));
  }
  y++;
  buf.push(put(r, y++, 0, `${T.title}por bot${RESET}`));
  for (const [bot, t] of s.byBot.slice(0, 5)) {
    if (y >= r.h - 2) break;
    buf.push(put(r, y++, 0, `${T.dim}${pad(bot, 16)}${RESET}${pad(`${t.n}t`, 6)}${T.dim}${pad(per(t.w / t.n), 8)}${RESET}${col(t.r)}${sr(t.r)}${RESET}`));
  }
}

// ------------------------------------------------------------------ main
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const demo = args.includes("--demo"); // dados sintéticos, sem ligação — para docs/SVG
  const symIdx = args.indexOf("--symbols");
  const symbols =
    symIdx >= 0 && args[symIdx + 1] ? args[symIdx + 1]!.split(",") : [GOLD_SYMBOL];

  const cfg = loadRiskCfg();
  const m: Model = {
    connected: false,
    accountId: "…",
    isDemo: true,
    currency: "USD",
    balance: 0,
    startBalance: 0,
    startedAt: Date.now(),
    prices: new Map(symbols.map((s) => [s, [] as number[]])),
    lastTick: new Map(),
    logLines: loadLog(60),
    learn: loadLearn(),
    trades: loadTrades(),
    market: null,
    goldDay: null,
    session: loadSession(),
    botStatus: parseBotStatus(loadLog(60)),
    monitorMode: cfg.account?.mode === "real" ? "real" : "demo",
    confirmReal: false,
    priceIdx: 0,
    showStats: false,
    disconnectedSince: 0,
    err: "",
  };

  if (demo) {
    if (args.includes("--stats")) m.showStats = true; // p/ pré-visualizar o overlay [t]
    const now = Date.now();
    m.connected = true;
    m.startedAt = now - 34 * 60000;
    m.accountId = "DOT94371782";
    m.balance = 9948.6;
    m.startBalance = 9945.88;
    let px = 4431;
    const ser: number[] = [];
    for (let i = 0; i < 600; i++) {
      px += Math.sin(i / 23) * 0.9 + (Math.random() - 0.5) * 1.4 + (i > 400 ? 0.04 : -0.02);
      ser.push(Number(px.toFixed(2)));
    }
    m.priceIdx = 0;
    m.prices.set("frxXAUUSD", ser);
    m.lastTick.set("frxXAUUSD", ser[ser.length - 1]!);
    const midnight = Math.floor(now / 86400000) * 86400000;
    m.market = {
      open: true,
      live: true,
      note: "Fridays: Closes early (at 20:55)",
      intervals: [
        { open: midnight / 1000, close: (midnight + 21 * 3600000) / 1000 },
        { open: (midnight + 22 * 3600000) / 1000, close: (midnight + 86399000) / 1000 },
      ],
    };
    m.goldDay = { open: 4433.1, prevClose: 4429.4 };
    m.session = {
      openBalance: 9945.88,
      openTs: now - 9_600_000,
      lastBalance: 9948.6,
      lastTs: now - 40_000,
      prevOpenBalance: 9951.2,
      prevCloseBalance: 9945.88,
      prevOpenTs: now - 96_000_000,
      prevCloseTs: now - 86_000_000,
    };
    m.trades = {
      open: [
        {
          botId: "xau-newyork",
          tag: "ny_up",
          dir: "up",
          entry: ser[ser.length - 40]!,
          stopDist: 5.6,
          slPrice: ser[ser.length - 40]! - 5.6,
          tpPrice: ser[ser.length - 40]! + 8.4,
          ts: now - 640_000,
        },
      ],
      closed: [
        { ts: now - 26_400_000, botId: "xau-london", symbol: "frxXAUUSD", tag: "mr_short", profit: 1.9, isWin: true, r: 0.95 },
        { ts: now - 24_900_000, botId: "xau-london", symbol: "frxXAUUSD", tag: "mr_long", profit: -2.0, isWin: false, r: -1.0 },
        { ts: now - 23_100_000, botId: "xau-london", symbol: "frxXAUUSD", tag: "mr_short", profit: 2.85, isWin: true, r: 1.42 },
        { ts: now - 12_600_000, botId: "xau-tokyo", symbol: "frxXAUUSD", tag: "mr_long", profit: -1.0, isWin: false, r: -1.0 },
        { ts: now - 8_600_000, botId: "xau-newyork", symbol: "frxXAUUSD", tag: "ny_dn", profit: -2.0, isWin: false, r: -1.0 },
        { ts: now - 6_100_000, botId: "xau-tokyo", symbol: "frxXAUUSD", tag: "mr_short", profit: 1.5, isWin: true, r: 1.5 },
        { ts: now - 4_200_000, botId: "xau-newyork", symbol: "frxXAUUSD", tag: "ny_up", profit: 3.1, isWin: true, r: 1.55 },
      ],
    };
    m.botStatus = {
      ts: now - 20_000,
      risk: { pnlToday: 1.85, pnlTodayPct: 0.019, lossStreak: 0, halted: null },
      bots: [
        { id: "xau-london", stopped: false, open: false },
        { id: "xau-newyork", stopped: false, open: true },
      ],
    };
    m.learn = {
      bots: {
        "xau-newyork": {
          tuning: 0.1,
          onProbation: false,
          arms: { ny_up: { recent: [1, 0, 1, 1], trades: 4 }, ny_dn: { recent: [0, 1], trades: 2 } },
        },
      },
    };
    m.logLines = [
      "[2026-08-31T17:12:15Z] INFO  main status ...",
      "[2026-08-31T18:41:03Z] INFO  bot:xau-newyork ENTRAR ny_up stake=2 x100 SL=1.9 TP=2.85",
      "[2026-08-31T18:41:04Z] INFO  deriv socket aberto (autenticado via OTP)",
      "[2026-08-31T18:52:30Z] INFO  main reconectado e re-subscrito",
    ];
    render(m, cfg);
    out("\n");
    process.exit(0);
  }

  if (!process.env.DERIV_TOKEN) {
    m.err = "DERIV_TOKEN ausente";
  }

  const enterAlt = () => {
    if (!once) out(`${ESC}?1049h${ESC}?25l${ESC}2J`);
  };
  const leaveAlt = () => {
    if (!once) out(`${ESC}?25h${ESC}?1049l`);
  };
  process.on("exit", leaveAlt);
  process.on("SIGINT", () => {
    leaveAlt();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    leaveAlt();
    process.exit(0);
  });

  enterAlt();

  let client: DerivClient | null = null;
  let mktTick = 0;

  async function bringUp(mode: "demo" | "real"): Promise<void> {
    if (!process.env.DERIV_TOKEN) {
      m.err = "DERIV_TOKEN ausente";
      return;
    }
    try {
      client?.disconnect();
    } catch {
      /* ignore */
    }
    m.monitorMode = mode;
    m.connected = false;
    m.err = "";
    for (const s of symbols) m.prices.set(s, []);
    client = new DerivClient({
      token: process.env.DERIV_TOKEN,
      appId: process.env.DERIV_APP_ID || "1089",
      restBase: process.env.DERIV_REST_BASE || "https://api.derivws.com",
      mode,
      pingIntervalSec: 25,
      maxBackoffSec: 30,
    });
    client.on("balance", ({ balance }: any) => (m.balance = balance));
    client.on("tick", ({ symbol, quote }: any) => {
      m.lastTick.set(symbol, quote);
      const arr = m.prices.get(symbol);
      if (arr) {
        arr.push(quote);
        if (arr.length > 600) arr.shift();
      }
    });
    client.on("close", () => (m.connected = false));
    client.on("open", () => (m.connected = true));
    try {
      const acc = await client.connect();
      m.accountId = acc.accountId;
      m.isDemo = acc.isDemo;
      m.currency = acc.currency;
      m.balance = acc.balance;
      m.startBalance = acc.balance;
      m.connected = true;
      m.balance = (await client.subscribeBalance()) || acc.balance;
      for (const s of symbols) {
        try {
          const { prices } = await client.recentTicks(s, 300);
          m.prices.set(s, prices);
        } catch {
          /* símbolo fechado / indisponível */
        }
        await client.subscribeTicks(s).catch(() => void 0);
      }
      await fetchSchedules();
    } catch (e) {
      m.err = (e as Error).message.slice(0, 40);
    }
  }

  async function fetchSchedules(): Promise<void> {
    if (!client || !m.connected) return;
    m.market = (await client.marketSchedule(GOLD_SYMBOL).catch(() => null)) ?? m.market;
    try {
      const dc = await client.candlesOHLC(GOLD_SYMBOL, 3, 86400);
      if (dc.length >= 2) {
        m.goldDay = { open: dc[dc.length - 1]!.open, prevClose: dc[dc.length - 2]!.close };
      }
    } catch {
      /* mercado fechado / sem histórico */
    }
  }

  await bringUp(m.monitorMode);

  const refresh = () => {
    m.logLines = loadLog(60);
    m.learn = loadLearn();
    m.trades = loadTrades();
    m.session = loadSession();
    m.botStatus = parseBotStatus(m.logLines);
  };

  if (once) {
    await new Promise((r) => setTimeout(r, process.env.DERIV_TOKEN ? 9000 : 200));
    refresh();
    render(m, cfg);
    out("\n");
    client?.disconnect();
    process.exit(0);
  }

  let lastForce = 0;
  const timer = setInterval(async () => {
    refresh();
    // rastreia há quanto tempo a ligação está caída
    if (m.connected) m.disconnectedSince = 0;
    else if (!m.disconnectedSince) m.disconnectedSince = Date.now();
    // watchdog: sem ligação há > 45s -> força uma reconexão limpa (a cada 45s)
    if (!m.connected && process.env.DERIV_TOKEN && Date.now() - lastForce > 45_000) {
      lastForce = Date.now();
      if (client) client.forceReconnect();
      else void bringUp(m.monitorMode);
    }
    if (m.connected && ++mktTick % 180 === 0) await fetchSchedules();
    render(m, cfg);
  }, 1000);
  void timer;

  process.stdout.on("resize", () => {
    out(`${ESC}2J`);
    render(m, cfg);
  });

  // ---- atalhos de teclado ----
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (key: string) => {
      if (key === "" || key === "q") {
        leaveAlt();
        process.exit(0);
      } else if (m.confirmReal) {
        if (key === "s" || key === "y") {
          m.confirmReal = false;
          void bringUp("real").then(() => render(m, cfg));
        } else if (key === "n" || key === "") {
          m.confirmReal = false;
          render(m, cfg);
        }
      } else if (key === "t") {
        m.showStats = !m.showStats;
        out(`${ESC}2J`);
        render(m, cfg);
      } else if (key === "r") {
        out(`${ESC}2J`);
        refresh();
        if (!m.connected) {
          lastForce = Date.now();
          if (client) client.forceReconnect();
          else void bringUp(m.monitorMode);
        }
        render(m, cfg);
      } else if (key === "a") {
        if (m.monitorMode === "real") {
          void bringUp("demo").then(() => render(m, cfg));
        } else {
          m.confirmReal = true;
          render(m, cfg);
        }
      }
    });
  }
}

main().catch((e) => {
  out(`${ESC}?25h${ESC}?1049l`);
  console.error("dashboard:", (e as Error).message);
  process.exit(1);
});
