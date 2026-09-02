import type { Candle } from "./candles.ts";

/**
 * Estrutura diária do XAUUSD — porta a lógica do indicador MQL5
 * `XAUUSD_DailyStructure` (zonas R1/S1/R2/S2 a partir de máximas/mínimas H1,
 * nível de invalidação de ~10 dias, espessura de zona = ATR(H1) e viés EMA20/50
 * no H1). Aqui é usada como FILTRO compartilhado: todos os bots consultam antes
 * de entrar (só compra perto de suporte / a favor do viés, não vende dentro de
 * suporte, etc.).
 */

export interface StructureCfg {
  shortLookback: number; // barras H1 p/ R1/S1  (~24 = 1 dia)
  mediumLookback: number; // barras H1 p/ R2/S2 (~120 = 5 dias)
  invalLookback: number; // barras H1 p/ invalidação (~240 = 10 dias)
  atrPeriod: number; // ATR H1 p/ espessura da zona
  zoneAtrMult: number; // espessura da zona = ATR * este fator
  emaFast: number; // EMA rápida H1 (viés)
  emaSlow: number; // EMA lenta H1 (viés)
}

export const DEFAULT_STRUCTURE_CFG: StructureCfg = {
  shortLookback: 24,
  mediumLookback: 120,
  invalLookback: 240,
  atrPeriod: 14,
  zoneAtrMult: 0.6,
  emaFast: 20,
  emaSlow: 50,
};

export interface DailyStructure {
  r1: number;
  s1: number;
  r2: number;
  s2: number;
  invalLow: number; // menor mínima da janela longa — SL de compras / alvo de venda
  invalHigh: number; // maior máxima da janela longa — SL de vendas
  zoneHalf: number; // meia-espessura de cada zona
  bias: "up" | "down" | "neutral";
  emaFast: number;
  emaSlow: number;
}

function atr(cs: Candle[], period: number): number | null {
  if (cs.length < period + 1) return null;
  let s = 0;
  for (let i = cs.length - period; i < cs.length; i++) {
    const c = cs[i]!;
    const p = cs[i - 1]!;
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return s / period;
}

function ema(vals: number[], period: number): number | null {
  if (vals.length < period) return null;
  const k = 2 / (period + 1);
  let e = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < vals.length; i++) e = vals[i]! * k + e * (1 - k);
  return e;
}

/** `h1` em ordem cronológica; o último elemento é a última barra H1 FECHADA. */
export function computeStructure(h1: Candle[], cfg: StructureCfg = DEFAULT_STRUCTURE_CFG): DailyStructure | null {
  if (h1.length < Math.min(cfg.mediumLookback, 40) + 2) return null;

  const win = (n: number) => h1.slice(-Math.min(n, h1.length));
  const shortW = win(cfg.shortLookback);
  const medW = win(cfg.mediumLookback);
  const longW = win(cfg.invalLookback);

  const r1 = Math.max(...shortW.map((c) => c.high));
  const s1 = Math.min(...shortW.map((c) => c.low));
  const r2 = Math.max(...medW.map((c) => c.high));
  const s2 = Math.min(...medW.map((c) => c.low));
  const invalLow = Math.min(...longW.map((c) => c.low));
  const invalHigh = Math.max(...longW.map((c) => c.high));

  const a = atr(h1.slice(-(cfg.atrPeriod + 6)), cfg.atrPeriod);
  const zoneHalf = a && a > 0 ? a * cfg.zoneAtrMult : (r1 - s1) * 0.02 || 0.5;

  const closes = h1.map((c) => c.close);
  const ef = ema(closes, cfg.emaFast);
  const es = ema(closes, cfg.emaSlow);
  let bias: DailyStructure["bias"] = "neutral";
  if (ef != null && es != null && es > 0) {
    const gap = (ef - es) / es;
    if (gap > 0.0005) bias = "up";
    else if (gap < -0.0005) bias = "down";
  }

  return { r1, s1, r2, s2, invalLow, invalHigh, zoneHalf, bias, emaFast: ef ?? 0, emaSlow: es ?? 0 };
}

/** Zona que o preço está tocando agora (dentro de ±k*zoneHalf do nível), ou null. */
export function zoneAt(
  price: number,
  st: DailyStructure,
  k = 1.0,
): { name: "s1" | "s2" | "r1" | "r2"; kind: "support" | "resistance" } | null {
  const band = st.zoneHalf * k;
  if (Math.abs(price - st.s1) <= band) return { name: "s1", kind: "support" };
  if (Math.abs(price - st.s2) <= band) return { name: "s2", kind: "support" };
  if (Math.abs(price - st.r1) <= band) return { name: "r1", kind: "resistance" };
  if (Math.abs(price - st.r2) <= band) return { name: "r2", kind: "resistance" };
  return null;
}

export type StructureMode = "off" | "block-counter" | "require-zone";

/**
 * Filtro compartilhado: a entrada `dir` faz sentido dada a estrutura?
 *  - "block-counter" (padrão): só barra o que vai claramente CONTRA a estrutura
 *    (contra o viés forte, comprando dentro de resistência, vendendo dentro de
 *    suporte, ou além da invalidação).
 *  - "require-zone": além disso, exige que o preço esteja numa zona a favor.
 */
export function structureGate(
  dir: "up" | "down",
  price: number,
  st: DailyStructure,
  mode: StructureMode = "block-counter",
  k = 1.2,
): { ok: boolean; reason: string; zone: string | null } {
  const z = zoneAt(price, st, k);
  const buying = dir === "up";
  const zn = z?.name ?? null;
  // zona "a favor" da entrada: comprar num suporte, vender numa resistência —
  // um fade legítimo, permitido mesmo contra o viés
  const atFavZone = z && ((buying && z.kind === "support") || (!buying && z.kind === "resistance"));

  // 1) sempre barra: entrar direto contra uma zona (comprar na resistência / vender no suporte)
  if (z && !atFavZone) {
    return { ok: false, reason: `${buying ? "compra" : "venda"} dentro de ${z.name}`, zone: zn };
  }

  // 2) sempre barra: além da invalidação da estrutura
  if (buying && price < st.invalLow) return { ok: false, reason: "abaixo da invalidação", zone: zn };
  if (!buying && price > st.invalHigh) return { ok: false, reason: "acima da invalidação", zone: zn };

  // 3) viés forte contra a entrada — só quando NÃO está numa zona a favor
  if (!atFavZone) {
    if (buying && st.bias === "down") return { ok: false, reason: "viés H1 de baixa (fora de zona)", zone: zn };
    if (!buying && st.bias === "up") return { ok: false, reason: "viés H1 de alta (fora de zona)", zone: zn };
  }

  // 4) require-zone: exige o preço numa zona a favor
  if (mode === "require-zone" && !atFavZone) {
    return { ok: false, reason: `fora de zona de ${buying ? "suporte" : "resistência"}`, zone: zn };
  }

  return { ok: true, reason: atFavZone ? `fade @ ${z!.name}` : "ok", zone: zn };
}
