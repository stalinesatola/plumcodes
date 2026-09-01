/** O único par operado. */
export const GOLD_SYMBOL = "frxXAUUSD";

/**
 * As 5 grandes sessões de negociação (horas UTC aproximadas — variam ~1h com o
 * horário de verão). Usadas só como CONTEXTO no monitor: o preço do ouro segue o
 * revezamento Sydney → Tokyo → Frankfurt → London → New York, e o overlap
 * London+New York (13–16 UTC) concentra a maior volatilidade do XAUUSD.
 * `end` pode ser menor que `start` (a sessão cruza a meia-noite).
 */
export interface Session {
  key: string;
  label: string;
  hours: [number, number];
}

export const SESSIONS: Session[] = [
  { key: "sydney", label: "Sydney", hours: [22, 7] },
  { key: "tokyo", label: "Tokyo", hours: [0, 9] },
  { key: "frankfurt", label: "Frankfurt", hours: [7, 16] },
  { key: "london", label: "London", hours: [8, 17] },
  { key: "newyork", label: "New York", hours: [13, 22] },
];

const inRange = (h: number, a: number, b: number) => (a <= b ? h >= a && h < b : h >= a || h < b);

/** A sessão está aberta agora? (considera fim de semana: mercado FX fecha
 *  sáb ~00 UTC e reabre dom ~22 UTC.) */
export function sessionOpen(s: Session, now = new Date()): boolean {
  const dow = now.getUTCDay();
  const h = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (dow === 6) return false; // sábado
  if (dow === 0 && !(s.key === "sydney" && h >= 22)) return false; // domingo (só a reabertura de Sydney)
  return inRange(h, s.hours[0], s.hours[1]);
}

/** ms até a próxima abertura (0 se já aberta). */
export function nextOpenMs(s: Session, now = new Date()): number {
  if (sessionOpen(s, now)) return 0;
  for (let add = 0; add < 72; add++) {
    const t = new Date(now.getTime() + add * 3600_000);
    // início da sessão nesse dia/hora?
    if (Math.floor(t.getUTCHours()) === s.hours[0] && t.getUTCMinutes() < 60 && sessionOpen(s, new Date(t.getTime() + 60_000))) {
      return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), s.hours[0], 0, 0)).getTime() - now.getTime();
    }
  }
  return 0;
}

/** ms até o fecho (0 se fechada). */
export function closeInMs(s: Session, now = new Date()): number {
  if (!sessionOpen(s, now)) return 0;
  const h = now.getUTCHours();
  let end = s.hours[1];
  let day = now;
  if (s.hours[0] > s.hours[1] && h >= s.hours[0]) day = new Date(now.getTime() + 86400_000); // cruzou meia-noite
  const closeT = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), end, 0, 0);
  return Math.max(0, closeT - now.getTime());
}
