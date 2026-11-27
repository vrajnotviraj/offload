import type { Account } from "@/lib/drive/api";
import { googleAuthUrl } from "@/lib/mcp/google";
import { esc, FLOW_TTL, MAX_ACCOUNTS, page } from "@/lib/mcp/oauth";
import type { Flow } from "@/lib/mcp/oauth";
import { seal } from "@/lib/mcp/seal";
import { botUsername, escHtml, send } from "./api";
import { getChat, saveChat } from "./store";

/**
 * Linking Google accounts to a Telegram chat reuses the connector's sign-in pages (app/oauth/callback): the flow
 * carries the chat id in `p.tg` instead of an AI app's request, and Finish saves the accounts for that chat.
 */

/** The link the bot sends for /start and /link. It opens /telegram/link, which explains the sign-in. */
export function linkUrl(site: string, chatId: number): string {
  const flow: Flow = { p: { cid: "telegram", r: "", cc: "", tg: chatId }, accts: [] };
  return `${site}/telegram/link?state=${encodeURIComponent(seal("flow", flow, FLOW_TTL))}`;
}

/** First page of the Telegram sign-in: what Offload will do, then Google's screen for the main account. */
export function linkStartPage(redirectUri: string, state: string) {
  return page({
    step: "Step 1",
    title: "Sign in with the account that's running out of space",
    body:
      "<p>The Offload bot in Telegram will be able to show your storage, find files and move Google Drive files between your " +
      "Google accounts, by handing over ownership.</p>" +
      "<p>First, choose the account you want to <strong>free up</strong>: your main account. Next you'll add the accounts that " +
      `<strong>receive</strong> files, from one up to ${MAX_ACCOUNTS - 1} more.</p>` +
      "<p>Google will also ask about Google Photos and Contacts. The bot doesn't use them yet, so you can leave them unticked.</p>" +
      '<p class="fine">Google may say the app isn\'t verified. Choose Advanced, then Go to Offload. Your sign-in is kept sealed for your ' +
      "Telegram chat only. Send /unlink to the bot to remove it, or remove Offload at myaccount.google.com/permissions.</p>",
    button: { href: googleAuthUrl(redirectUri, state), label: "Choose the account to free up" },
  });
}

/** Finish: save the accounts for the chat, tell the chat, and send the person back to Telegram. */
export async function finishTelegramLink(chatId: number, accts: Account[]) {
  const prev = await getChat(chatId);
  await saveChat(chatId, { accts });
  const list = accts.map((a, i) => `${i + 1}. ${escHtml(a.e)}${i === 0 ? " (main)" : ""}`).join("\n");
  await send(
    chatId,
    `✅ <b>${accts.length} Google accounts linked</b>${prev ? " (they replace the ones linked before)" : ""}\n\n${list}\n\n` +
      "Try /storage to see how much room each has, or /big to see the biggest files in the fullest one."
  ).catch(() => {});
  const bot = await botUsername();
  const rows = accts
    .map((a, i) => `<li><strong>${esc(a.e)}</strong><span class="tag">${i === 0 ? "main account" : `account ${i + 1}`}</span></li>`)
    .join("");
  return page({
    step: "All set",
    title: `${accts.length} accounts linked to Telegram`,
    body: `<ul class="accts">${rows}</ul><p>Go back to Telegram: the Offload bot has sent you a message.</p>`,
    ...(bot ? { button: { href: `https://t.me/${bot}`, label: "Back to Telegram" } } : {}),
  });
}
