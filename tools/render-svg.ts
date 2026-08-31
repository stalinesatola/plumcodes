/**
 * render-svg.ts — converte um quadro do dashboard (ANSI) num SVG para o README.
 *
 *   node tools/render-svg.ts [out.svg]        # usa dados sintéticos (--demo)
 *   node --env-file=.env tools/render-svg.ts out.svg --live   # captura ao vivo
 *
 * Faithful: parseia posicionamento de cursor + cores truecolor e emite um <text>
 * por corrida de mesma cor. Fundo escuro, fonte monoespaçada.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const outPath = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "docs/dashboard.svg";
const live = process.argv.includes("--live");

const COLS = 132;
const ROWS = 40;
const CW = 8.4; // largura de célula (px) para 14px mono
const CH = 17; // altura de linha
const BG = "#0b0e14";
const DEFAULT_FG = "#c5c8c6";

const res = spawnSync(
  process.execPath,
  live
    ? ["tools/dashboard.ts", "--once"]
    : ["tools/dashboard.ts", "--once", "--demo"],
  { encoding: "utf8", env: { ...process.env, COLUMNS: String(COLS), LINES: String(ROWS) }, maxBuffer: 8 << 20 },
);
const ansi = res.stdout || "";
if (!ansi) {
  console.error("sem saída do dashboard:", res.stderr?.slice(0, 400));
  process.exit(1);
}

interface Cell {
  ch: string;
  fg: string;
  bold: boolean;
}
const grid: Cell[][] = Array.from({ length: ROWS }, () =>
  Array.from({ length: COLS }, () => ({ ch: " ", fg: DEFAULT_FG, bold: false })),
);

let cr = 0;
let cc = 0;
let fg = DEFAULT_FG;
let bold = false;

for (let i = 0; i < ansi.length; i++) {
  const chr = ansi[i]!;
  if (chr === "\x1b" && ansi[i + 1] === "[") {
    const mt = ansi.slice(i).match(/^\x1b\[([0-9;]*)([A-Za-z])/);
    if (!mt) continue;
    const params = mt[1]!.split(";").filter((x) => x !== "").map(Number);
    const cmd = mt[2]!;
    i += mt[0].length - 1;
    if (cmd === "H") {
      cr = (params[0] ?? 1) - 1;
      cc = (params[1] ?? 1) - 1;
    } else if (cmd === "m") {
      if (params.length === 0) {
        fg = DEFAULT_FG;
        bold = false;
      }
      for (let k = 0; k < params.length; k++) {
        const p = params[k]!;
        if (p === 0) {
          fg = DEFAULT_FG;
          bold = false;
        } else if (p === 1) bold = true;
        else if (p === 2) {
          /* dim — mantém fg */
        } else if (p === 38 && params[k + 1] === 2) {
          fg = `#${[params[k + 2], params[k + 3], params[k + 4]].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
          k += 4;
        } else if (p === 48 && params[k + 1] === 2) {
          k += 4; // bg ignorado (fundo fixo)
        }
      }
    }
    continue;
  }
  if (chr === "\n") {
    cr++;
    cc = 0;
    continue;
  }
  if (chr === "\r") {
    cc = 0;
    continue;
  }
  if (cr >= 0 && cr < ROWS && cc >= 0 && cc < COLS) grid[cr]![cc] = { ch: chr, fg, bold };
  cc++;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

let maxCol = 0;
const texts: string[] = [];
for (let r = 0; r < ROWS; r++) {
  let c = 0;
  while (c < COLS) {
    const cell = grid[r]![c]!;
    if (cell.ch === " ") {
      c++;
      continue;
    }
    let run = "";
    const startC = c;
    const { fg: rfg, bold: rbold } = cell;
    while (c < COLS && grid[r]![c]!.ch !== " " && grid[r]![c]!.fg === rfg && grid[r]![c]!.bold === rbold) {
      run += grid[r]![c]!.ch;
      c++;
    }
    maxCol = Math.max(maxCol, c);
    texts.push(
      `<text x="${(startC * CW).toFixed(1)}" y="${(r * CH + 13).toFixed(1)}" fill="${rfg}"${rbold ? ' font-weight="600"' : ""}>${esc(run)}</text>`,
    );
  }
}

let lastRow = 0;
for (let r = ROWS - 1; r >= 0; r--) {
  if (grid[r]!.some((x) => x.ch !== " ")) {
    lastRow = r + 1;
    break;
  }
}

const W = Math.ceil(Math.max(maxCol, 80) * CW) + 24;
const H = lastRow * CH + 20;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="14">
<rect width="${W}" height="${H}" rx="8" fill="${BG}"/>
<g transform="translate(12,8)" xml:space="preserve">
${texts.join("\n")}
</g>
</svg>
`;

writeFileSync(outPath, svg);
console.log(`escrito ${outPath}  (${W}×${H}, ${texts.length} spans)`);
