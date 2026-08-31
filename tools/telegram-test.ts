/**
 * Testa os alertas do Telegram.
 *   node --env-file=.env tools/telegram-test.ts
 *
 * Envia uma mensagem de teste usando TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
 */
import { initTelegram, tgRaw, tgEnabled } from "../src/util/telegram.ts";

initTelegram({ enabled: true });

if (!tgEnabled()) {
  console.error(
    "Telegram desativado — falta TELEGRAM_BOT_TOKEN e/ou TELEGRAM_CHAT_ID no .env.\n" +
      "Veja as instruções em .env.example.",
  );
  process.exit(1);
}

tgRaw(
  `✅ <b>Teste OK</b>\n` +
    `Os alertas do Deriv Quant Research Framework estão a funcionar.\n` +
    `${new Date().toISOString()}`,
);
console.log("mensagem enfileirada — deve chegar em ~1s. Ctrl+C para sair.");
setTimeout(() => process.exit(0), 4000);
