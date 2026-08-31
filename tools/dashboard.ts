/**
 * dashboard.ts — monitor TUI estilo btop para o Deriv Quant Research Framework.
 *
 *   node --env-file=.env tools/dashboard.ts [--symbols frxXAUUSD,R_75,R_100] [--once]
 *
 * Conecta na conta demo, assina saldo + ticks dos símbolos, e desenha painéis
 * (conta / preços com gráfico braille / risco / estratégias / aprendizado / log)
 * com cantos arredondados, medidores em gradiente e sparklines — no espírito do btop.
 *
 * `--once` renderiza um quadro no stdout e sai (para inspeção/CI).
 * Sem dependências além de `ws` (via DerivClient). Ctrl+C restaura o terminal.
 */
process.env.LOG_SILENT = "1"; // silencia o logger do DerivClient (antes do import)
import { readFileSync, existsSync } from "node:fs";
import { DerivClient } from "../src/deriv/client.ts";
import { getStrategy } from "../src/strategies/index.ts";

// ------------------------------------------------------------------ ANSI / tema
const ESC = "\x1b[";
const rgb = (r: number, g: number, b: number) => `${ESC}38;2;${r};${g};${b}m`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;

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
  err: string;
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
  const W = Math.max(80, process.stdout.columns || 100);
  const H = Math.max(24, process.stdout.rows || 30);
  const buf: string[] = [`${ESC}H`]; // home (não limpa: menos flicker)

  // header
  const clock = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
  const conn = m.connected ? T.green + "● connected" : m.err ? T.red + "● " + m.err : T.yellow + "● connecting";
  const head = `${T.cyan}${BOLD}deriv quant research${RESET}${T.dim} · monitor${RESET}   ${conn}${RESET}${T.dim}   up ${humanDur(Date.now() - m.startedAt)}   ${clock}${RESET}`;
  buf.push(at(1, 2) + pad(clip(head, W - 3), W - 3));

  const symbols = [...m.prices.keys()];
  const top = 3;
  const colW = Math.floor((W - 3) / 3);

  // ---- ACCOUNT (topo-esquerda) ----
  const acc: Rect = { x: 2, y: top, w: colW - 1, h: 8 };
  buf.push(...box(acc, " account ", T.cyan));
  const pnl = m.balance - m.startBalance;
  const pnlPct = m.startBalance ? (pnl / m.startBalance) * 100 : 0;
  const pnlCol = pnl > 0 ? T.green : pnl < 0 ? T.red : T.dim;
  buf.push(put(acc, 0, 0, `${T.dim}${m.accountId}  ${m.isDemo ? T.blue + "DEMO" : T.red + "REAL"}${RESET}`));
  buf.push(put(acc, 1, 0, `${T.text}${BOLD}${fmtMoney(m.balance, m.currency)}${RESET}`));
  buf.push(
    put(acc, 2, 0, `${T.dim}session P/L ${pnlCol}${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)${RESET}`),
  );
  const slPct = cfg.risk?.dailyStopLossPct ?? 10;
  const tpPct = cfg.risk?.dailyTakeProfitPct ?? 15;
  const towardStop = Math.max(0, -pnlPct) / slPct;
  const towardTake = Math.max(0, pnlPct) / tpPct;
  buf.push(put(acc, 4, 0, meter(towardStop, acc.w - 4, `${T.red}stop ${slPct}%${RESET}`)));
  buf.push(put(acc, 5, 0, meter(towardTake, acc.w - 4, `${T.green}take ${tpPct}%${RESET}`)));

  // ---- RISK (topo-centro) ----
  const risk: Rect = { x: 2 + colW, y: top, w: colW - 1, h: 8 };
  buf.push(...box(risk, " risk ", T.mag));
  const halted = towardStop >= 1;
  const state = halted ? T.red + "HALT" : towardTake >= 1 ? T.green + "TARGET" : T.green + "OK";
  buf.push(put(risk, 0, 0, `${T.dim}state${RESET}    ${BOLD}${state}${RESET}`));
  buf.push(put(risk, 1, 0, `${T.dim}floor${RESET}    ${T.text}${cfg.risk?.hardFloorBalance ?? 5} ${m.currency}${RESET}`));
  buf.push(put(risk, 2, 0, `${T.dim}streak → pause${RESET}  ${T.text}${cfg.risk?.globalLossStreakPause ?? 8}${RESET}`));
  buf.push(put(risk, 3, 0, `${T.dim}max concurrent${RESET} ${T.text}${cfg.risk?.maxConcurrentBots ?? 3}${RESET}`));
  const nBots = (cfg.bots ?? []).filter((b: any) => b.enabled).length;
  buf.push(
    put(risk, 5, 0, `${T.dim}active bots${RESET}   ${nBots === 0 ? T.yellow + "0 — see FINDINGS.md" : T.green + nBots}${RESET}`),
  );

  // ---- BOTS (topo-direita) ----
  const strat: Rect = { x: 2 + colW * 2, y: top, w: W - 3 - colW * 2, h: 8 };
  buf.push(...box(strat, " bots ", T.blue));
  const bots: any[] = cfg.bots ?? [];
  let sr = 0;
  for (const b of bots) {
    if (sr >= strat.h - 2) break;
    const hasOpen = m.trades.open.some((o) => o.botId === b.id);
    const dot = !b.enabled ? T.dim + "○" : hasOpen ? T.yellow + "●" : T.green + "●";
    const bt = m.trades.closed.filter((c) => c.botId === b.id);
    const w = bt.filter((c) => c.isWin).length;
    const rr = bt.reduce((s, c) => s + c.r, 0);
    const stat = bt.length
      ? `${T.dim}${w}/${bt.length - w} ${rr >= 0 ? T.green : T.red}${rr >= 0 ? "+" : ""}${rr.toFixed(1)}R${RESET}`
      : `${T.dim}—${RESET}`;
    buf.push(put(strat, sr++, 0, `${dot}${RESET} ${T.text}${b.id}${RESET} ${T.dim}${b.symbol}${RESET}  ${stat}`));
  }
  if (bots.length === 0) buf.push(put(strat, 0, 0, `${T.yellow}config.json → bots: []${RESET}`));

  const sym = symbols[0] ?? "frxXAUUSD";
  const ser = m.prices.get(sym) ?? [];
  const last = m.lastTick.get(sym) ?? (ser.length ? ser[ser.length - 1]! : 0);
  const dec = sym.startsWith("frx") ? 2 : 4;

  // ---- PRICE (largo) ----
  const pTop = top + 8;
  const avail = H - pTop - 1;
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
  const bH = Math.max(5, H - bY - 1);
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

  out(buf.join(""));
}

// ------------------------------------------------------------------ main
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const once = args.includes("--once");
  const symIdx = args.indexOf("--symbols");
  const symbols =
    symIdx >= 0 && args[symIdx + 1] ? args[symIdx + 1]!.split(",") : ["frxXAUUSD"];

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
    logLines: loadLog(40),
    learn: loadLearn(),
    trades: loadTrades(),
    err: "",
  };

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
  if (process.env.DERIV_TOKEN) {
    client = new DerivClient({
      token: process.env.DERIV_TOKEN,
      appId: process.env.DERIV_APP_ID || "1089",
      restBase: process.env.DERIV_REST_BASE || "https://api.derivws.com",
      mode: cfg.account?.mode === "real" ? "real" : "demo",
      pingIntervalSec: 25,
      maxBackoffSec: 30,
    });
    client.on("balance", ({ balance }: any) => {
      m.balance = balance;
      if (!m.startBalance) m.startBalance = balance;
    });
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

    (async () => {
      try {
        const acc = await client!.connect();
        m.accountId = acc.accountId;
        m.isDemo = acc.isDemo;
        m.currency = acc.currency;
        m.balance = acc.balance;
        m.startBalance = acc.balance;
        m.connected = true;
        m.balance = (await client!.subscribeBalance()) || acc.balance;
        for (const s of symbols) {
          try {
            const { prices } = await client!.recentTicks(s, 300);
            m.prices.set(s, prices);
          } catch {
            /* símbolo fechado / indisponível */
          }
          await client!.subscribeTicks(s).catch(() => void 0);
        }
      } catch (e) {
        m.err = (e as Error).message.slice(0, 40);
      }
    })();
  }

  if (once) {
    // dá um tempo para conectar e pegar 1 leitura
    await new Promise((r) => setTimeout(r, process.env.DERIV_TOKEN ? 9000 : 200));
    m.logLines = loadLog(40);
    m.learn = loadLearn();
    m.trades = loadTrades();
    render(m, cfg);
    out("\n");
    client?.disconnect();
    process.exit(0);
  }

  const timer = setInterval(() => {
    m.logLines = loadLog(40);
    m.learn = loadLearn();
    m.trades = loadTrades();
    render(m, cfg);
  }, 1000);
  process.stdout.on("resize", () => {
    out(`${ESC}2J`);
    render(m, cfg);
  });
  // keep alive
  void timer;
}

main().catch((e) => {
  out(`${ESC}?25h${ESC}?1049l`);
  console.error("dashboard:", (e as Error).message);
  process.exit(1);
});
