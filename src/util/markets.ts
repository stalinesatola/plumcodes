/** Mercados/instrumentos e as suas janelas de sessão principal (horas UTC). */
export interface MarketDef {
  key: string;
  label: string;
  symbol: string;
  /** janela de sessão principal [inicio, fim) em horas UTC */
  session: [number, number];
  /** casas decimais para exibição */
  dec: number;
  /** contrato: "mult" (MULTUP/MULTDOWN) ou "binary" (CALL/PUT 15m) */
  contract: "mult" | "binary";
}

export const MARKETS: MarketDef[] = [
  { key: "sydney", label: "Sydney · Australia 200", symbol: "OTC_AS51", session: [0, 6], dec: 1, contract: "binary" },
  { key: "tokyo", label: "Tokyo · Japan 225", symbol: "OTC_N225", session: [0, 6], dec: 1, contract: "binary" },
  { key: "frankfurt", label: "Frankfurt · Germany 40", symbol: "OTC_GDAXI", session: [7, 16], dec: 1, contract: "binary" },
  { key: "gold", label: "Gold / USD", symbol: "frxXAUUSD", session: [7, 20], dec: 2, contract: "mult" },
];

export const marketBySymbol = (s: string): MarketDef | undefined => MARKETS.find((m) => m.symbol === s);
