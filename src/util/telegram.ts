import { createLogger } from "./logger.ts";

/**
 * Alertas para o Telegram via Bot API (sem dependências — usa fetch).
 *
 * Requer no ambiente:
 *   TELEGRAM_BOT_TOKEN  (do @BotFather)
 *   TELEGRAM_CHAT_ID    (id do chat/grupo/canal; use @userinfobot ou getUpdates)
 *
 * Se qualquer um faltar, tudo vira no-op silencioso. As mensagens são
 * enfileiradas e enviadas a ~1/s para respeitar o rate-limit do Telegram.
 */
const log = createLogger("telegram");

let enabled = false;
let token = "";
let chat = "";
const events = { open: true, close: true, lifecycle: true, risk: true };
const queue: string[] = [];
let draining = false;

export function initTelegram(opts: {
  enabled: boolean;
  onTradeOpen?: boolean;
  onTradeClose?: boolean;
  onBotStartStop?: boolean;
  onRiskEvent?: boolean;
}): void {
  token = process.env.TELEGRAM_BOT_TOKEN ?? "";
  chat = process.env.TELEGRAM_CHAT_ID ?? "";
  enabled = !!opts.enabled && !!token && !!chat;
  events.open = opts.onTradeOpen ?? true;
  events.close = opts.onTradeClose ?? true;
  events.lifecycle = opts.onBotStartStop ?? true;
  events.risk = opts.onRiskEvent ?? true;

  if (opts.enabled && !enabled) {
    log.warn("alerts.telegram ligado mas TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID ausentes — desativado");
  } else if (enabled) {
    log.info("alertas Telegram ativos");
  }
}

function send(text: string): void {
  if (!enabled) return;
  queue.push(text);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const text = queue.shift()!;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chat,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
          }),
        });
        if (r.ok) break;
        log.warn(`sendMessage HTTP ${r.status}`);
        if (r.status === 429) await new Promise((res) => setTimeout(res, 3000));
      } catch (e) {
        log.warn("falha ao enviar", (e as Error).message);
      }
    }
    await new Promise((res) => setTimeout(res, 1200));
  }
  draining = false;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function tgTradeOpen(msg: string): void {
  if (events.open) send(msg);
}
export function tgTradeClose(msg: string): void {
  if (events.close) send(msg);
}
export function tgLifecycle(msg: string): void {
  if (events.lifecycle) send(msg);
}
export function tgRisk(msg: string): void {
  if (events.risk) send(msg);
}
/** Envio direto (usado pelo heartbeat e por telegram-test). */
export function tgRaw(msg: string): void {
  send(msg);
}
export { esc as tgEsc };
export const tgEnabled = () => enabled;
