/** A small caller for the Telegram Bot API. The bot token comes from TELEGRAM_BOT_TOKEN (made with @BotFather). */

export type InlineButton = { text: string; url?: string; callback_data?: string };
export type Keyboard = InlineButton[][];

function botToken(): string {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error("TELEGRAM_BOT_TOKEN is not set.");
  return t;
}

export async function tg<T = any>(method: string, body: object): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description || res.status}`);
  return data.result as T;
}

/** Sends an HTML message. Returns its message_id, so it can be edited later (progress updates). */
export async function send(chatId: number, html: string, keyboard?: Keyboard): Promise<number> {
  const msg = await tg<{ message_id: number }>("sendMessage", {
    chat_id: chatId,
    text: html,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
  return msg.message_id;
}

export async function edit(chatId: number, messageId: number, html: string, keyboard?: Keyboard) {
  try {
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard || [] },
    });
  } catch (e) {
    // Telegram refuses an edit that changes nothing; that's fine.
    if (!String(e).includes("not modified")) throw e;
  }
}

export async function answerCallback(id: string, text?: string) {
  await tg("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) }).catch(() => {});
}

export async function typing(chatId: number) {
  await tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

let username: string | null = null;
/** The bot's @username, for "go back to Telegram" links. */
export async function botUsername(): Promise<string | null> {
  if (username) return username;
  if (process.env.TELEGRAM_BOT_USERNAME) return (username = process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, ""));
  try {
    username = (await tg<{ username: string }>("getMe", {})).username;
  } catch {
    return null;
  }
  return username;
}

export const escHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
