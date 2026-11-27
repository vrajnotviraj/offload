import { randomBytes } from "node:crypto";
import type { Account } from "@/lib/drive/api";
import { findFiles, human, storage, transfer, type FindOpts, type TransferResult } from "@/lib/drive/engine";
import { revokeGoogle } from "@/lib/mcp/google"; // importing it also registers the server-side Google token source
import { answerCallback, edit, escHtml as h, send, typing, type Keyboard } from "./api";
import { linkUrl } from "./link";
import { deleteChat, getChat, saveChat, type Chat, type ListedItem } from "./store";

/**
 * The Offload Telegram bot: plain commands, no AI. It uses the same Drive engine as the web app and the MCP connector.
 *
 *   /start, /link      link 2 to 5 Google accounts (the connector's sign-in pages)
 *   /storage           storage of every linked account
 *   /big [kind] [n]    biggest files, in the fullest account or account n
 *   /find <words>      files and folders by name, in every account
 *   /move 1 3 5-8 [to n]  move files from the last list to another account, after a Confirm button
 *   /unlink            forget the accounts
 */

const TRANSFER_BUDGET_MS = 40_000;
/** A move keeps going in steps for at most this long; /move again picks up where it stopped (moved items are skipped). */
const TRANSFER_MAX_MS = 30 * 60_000;
const LIST_LIMIT = 15;

type Message = { message_id: number; chat: { id: number; type: string }; text?: string };
type Callback = { id: string; data?: string; message?: Message };
export type Update = { update_id: number; message?: Message; callback_query?: Callback };

const HELP =
  "<b>Offload</b> moves Google Drive files between your own Google accounts, to free up space.\n\n" +
  "/storage – how much room each account has\n" +
  "/big – biggest files in the fullest account\n" +
  "/big videos 2 – biggest videos in account 2 (also photos, media, documents)\n" +
  "/find holiday – files and folders named holiday, in every account\n" +
  "/move 1 3 5-8 – move those items from the last list to your other account\n" +
  "/move 1 2 to 3 – …to account 3, when you've linked more than two\n" +
  "/link – link your Google accounts again\n" +
  "/unlink – forget your accounts\n\n" +
  "Moving hands over ownership, so the space is freed in the account the files leave. Nothing is deleted, and a move can be undone by moving the files back.";

export async function handleUpdate(update: Update, site: string) {
  if (update.callback_query) return onCallback(update.callback_query);
  const msg = update.message;
  if (!msg?.text) return;
  const chatId = msg.chat.id;
  if (msg.chat.type !== "private") {
    await send(chatId, "Offload works in a private chat only, since it holds your Google sign-in. Message me directly.");
    return;
  }
  const [rawCmd, ...rest] = msg.text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@.*$/, "");
  const args = rest.join(" ");
  try {
    await route(chatId, cmd, args, site);
  } catch (e) {
    await send(chatId, `⚠️ ${h(e instanceof Error ? e.message : String(e))}`).catch(() => {});
  }
}

async function route(chatId: number, cmd: string, args: string, site: string) {
  if (cmd === "/start" || cmd === "/link") {
    const chat = await getChat(chatId);
    const intro =
      cmd === "/start" && chat
        ? `You're linked with ${chat.accts.length} accounts. Send /storage to see them, or use the button to link a different set.`
        : "Hi! I move Google Drive files between your own Google accounts, so the full one gets its space back.\n\n" +
          "First, link your accounts: your main account (the one to free up), then 1 to 4 more that receive files. The link works for 30 minutes.";
    await send(chatId, intro, [[{ text: chat ? "Link accounts again" : "Link Google accounts", url: linkUrl(site, chatId) }]]);
    return;
  }
  if (cmd === "/help") return void (await send(chatId, HELP));

  const chat = await getChat(chatId);
  if (!chat) {
    await send(chatId, "First, link your Google accounts.", [[{ text: "Link Google accounts", url: linkUrl(site, chatId) }]]);
    return;
  }
  await typing(chatId);

  switch (cmd) {
    case "/storage":
    case "/accounts":
      return storageCmd(chatId, chat);
    case "/big":
      return bigCmd(chatId, chat, args);
    case "/find":
      return findCmd(chatId, chat, args);
    case "/move":
      return moveCmd(chatId, chat, args);
    case "/unlink":
      await deleteChat(chatId);
      await Promise.all(chat.accts.map((a) => revokeGoogle(a.r)));
      await send(chatId, "Done: I've forgotten your Google accounts and signed Offload out of them. Send /link to start again.");
      return;
    default:
      await send(chatId, HELP);
  }
}

/* ------------------------------ /storage ------------------------------ */

async function storageCmd(chatId: number, chat: Chat) {
  const all = await Promise.all(chat.accts.map(storage));
  const lines = all.map((s, i) => {
    const icon = s.status === "full" ? "🔴" : s.status === "almost full" ? "🟠" : "🟢";
    const room = s.bytes.total === null ? `${s.used} used, unlimited` : `${s.used} of ${s.total} (${s.percent_used}%), ${s.free} free`;
    return `${icon} <b>${i + 1}. ${h(s.email)}</b>${i === 0 ? " (main)" : ""}\n    ${room}`;
  });
  const limited = all.filter((s) => s.bytes.total !== null);
  const most = [...limited].sort((x, y) => y.bytes.free! - x.bytes.free!)[0];
  const fullest = [...limited].sort((x, y) => y.percent_used! - x.percent_used!)[0];
  const tail = [
    most && all.length > 1 ? `${h(most.email)} has the most room.` : "",
    fullest && fullest.percent_used! >= 80 ? `Send /big to see what's taking space in ${h(fullest.email)}.` : "",
  ].filter(Boolean);
  await send(chatId, `${lines.join("\n")}${tail.length ? `\n\n${tail.join(" ")}` : ""}\n\n<i>Google can take a few hours to update these after a move.</i>`);
}

/* ------------------------------ /big and /find ------------------------------ */

const KINDS: Record<string, FindOpts["kind"]> = {
  videos: "videos", video: "videos",
  photos: "images", photo: "images", images: "images", pictures: "images",
  media: "media",
  documents: "documents", docs: "documents",
};

/** Account number n (1-based), checked against the linked accounts. */
function accountAt(chat: Chat, n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > chat.accts.length) {
    throw new Error(`There's no account ${n}. You have ${chat.accts.length}: send /storage to see their numbers.`);
  }
  return n - 1;
}

async function bigCmd(chatId: number, chat: Chat, args: string) {
  let kind: FindOpts["kind"] = "all";
  let idx: number | null = null;
  for (const w of args.toLowerCase().split(/\s+/).filter(Boolean)) {
    if (KINDS[w]) kind = KINDS[w];
    else if (/^\d+$/.test(w)) idx = accountAt(chat, Number(w));
    else throw new Error(`I don't know "${w}". Try /big, /big videos, or /big photos 2.`);
  }
  if (idx === null) {
    const all = await Promise.all(chat.accts.map(storage));
    const ranked = all.map((s, i) => ({ i, p: s.percent_used ?? -1 })).sort((a, b) => b.p - a.p);
    idx = ranked[0].i;
  }
  const res = await findFiles(chat.accts[idx], { kind, sort: "largest", limit: LIST_LIMIT });
  const items: ListedItem[] = res.items.map((f) => ({ id: f.id, name: f.name, size: f.size, bytes: f.size_bytes, folder: false, acct: idx! }));
  await showList(chatId, chat, items, `Biggest ${kind === "all" ? "files" : kind === "images" ? "photos" : kind} in ${chat.accts[idx].e}`);
}

async function findCmd(chatId: number, chat: Chat, args: string) {
  const words = args.trim();
  if (!words) throw new Error("Tell me what to look for, like /find holiday.");
  const per = Math.max(3, Math.ceil(LIST_LIMIT / chat.accts.length));
  const results = await Promise.all(
    chat.accts.flatMap((acct, i) =>
      (["folders", "all"] as const).map(async (kind) => {
        const r = await findFiles(acct, { kind, name_contains: words, sort: kind === "folders" ? "name" : "largest", limit: per });
        return r.items.map((f) => ({ id: f.id, name: f.name, size: f.size, bytes: f.size_bytes, folder: kind === "folders", acct: i }));
      })
    )
  );
  const items = results.flat().slice(0, LIST_LIMIT * 2);
  await showList(chatId, chat, items, `Matches for “${words}”`);
}

async function showList(chatId: number, chat: Chat, items: ListedItem[], title: string) {
  chat.last = items;
  delete chat.move;
  await saveChat(chatId, chat);
  if (!items.length) return void (await send(chatId, `${h(title)}: nothing found.`));
  const multi = new Set(items.map((x) => x.acct)).size > 1;
  let lastAcct = -1;
  const lines: string[] = [];
  items.forEach((it, n) => {
    if (multi && it.acct !== lastAcct) {
      lines.push(`\n<b>${h(chat.accts[it.acct].e)}</b> (account ${it.acct + 1})`);
      lastAcct = it.acct;
    }
    lines.push(`${n + 1}. ${it.folder ? "📁 " : ""}${h(it.name)}${it.folder ? "" : ` · ${it.size}`}`);
  });
  const others = chat.accts.length > 2 ? " to 2" : "";
  await send(chatId, `<b>${h(title)}</b>\n${lines.join("\n")}\n\nTo move some: /move 1 3 5-7${others}`);
}

/* ------------------------------ /move ------------------------------ */

function parseNumbers(s: string, max: number): number[] {
  const out = new Set<number>();
  for (const part of s.split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`"${part}" isn't a number from the list. Use numbers like 1 3 5-8.`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) {
      if (n < 1 || n > max) throw new Error(`The last list only goes up to ${max}.`);
      out.add(n - 1);
    }
  }
  return [...out];
}

async function moveCmd(chatId: number, chat: Chat, args: string) {
  if (!chat.last?.length) throw new Error("First list some files with /big or /find, then move them by number.");
  const m = args.match(/^(.*?)(?:\s+to\s+(\S+))?\s*$/i)!;
  const picks = parseNumbers(m[1], chat.last.length);
  if (!picks.length) throw new Error("Say which items to move, like /move 1 3 5-8.");
  const items = picks.map((n) => chat.last![n]);
  const from = items[0].acct;
  if (items.some((x) => x.acct !== from)) throw new Error("Those items are in different accounts. Move one account's items at a time.");

  let to: number;
  if (m[2]) {
    const target = m[2].toLowerCase();
    const byEmail = chat.accts.findIndex((a) => a.e === target);
    to = byEmail >= 0 ? byEmail : accountAt(chat, Number(target));
  } else if (chat.accts.length === 2) {
    to = from === 0 ? 1 : 0;
  } else {
    const opts = chat.accts.map((a, i) => (i === from ? null : `${i + 1} (${a.e})`)).filter(Boolean);
    throw new Error(`Which account should receive them? Add "to" and its number: ${opts.join(", ")}.`);
  }
  if (to === from) throw new Error("They're already in that account. Pick a different one.");

  const bytes = items.filter((x) => !x.folder).reduce((s, x) => s + x.bytes, 0);
  const folders = items.filter((x) => x.folder).length;
  chat.move = { nonce: randomBytes(6).toString("base64url"), ids: items.map((x) => x.id), names: items.map((x) => x.name), bytes, from, to };
  await saveChat(chatId, chat);

  const names = items.slice(0, 10).map((x) => `• ${x.folder ? "📁 " : ""}${h(x.name)}${x.folder ? "" : ` (${x.size})`}`);
  if (items.length > 10) names.push(`• …and ${items.length - 10} more`);
  const size = [bytes ? human(bytes) : "", folders ? `${folders} folder${folders > 1 ? "s" : ""} with everything inside` : ""].filter(Boolean).join(" plus ");
  await send(
    chatId,
    `Move ${items.length} item${items.length > 1 ? "s" : ""} (${size})\nfrom <b>${h(chat.accts[from].e)}</b>\nto <b>${h(chat.accts[to].e)}</b>?\n\n${names.join("\n")}\n\n` +
      "This frees the space in the first account. Folders keep their structure; loose files land in “Transferred from …” in the receiving Drive.",
    [[{ text: "✅ Move them", callback_data: `mv:${chat.move.nonce}` }, { text: "Cancel", callback_data: `no:${chat.move.nonce}` }]]
  );
}

async function onCallback(cb: Callback) {
  const chatId = cb.message?.chat.id;
  const messageId = cb.message?.message_id;
  if (!chatId || !messageId || !cb.data) return answerCallback(cb.id);
  const [action, nonce] = cb.data.split(":");
  const chat = await getChat(chatId);
  const move = chat?.move;
  if (!chat || !move || move.nonce !== nonce) {
    await answerCallback(cb.id, "This one has expired. List the files again and send /move.");
    await edit(chatId, messageId, "This move has expired. List the files again with /big or /find, then /move.").catch(() => {});
    return;
  }
  delete chat.move;
  await saveChat(chatId, chat);
  if (action === "no") {
    await answerCallback(cb.id, "Cancelled");
    await edit(chatId, messageId, "Cancelled. Nothing was moved.");
    return;
  }
  await answerCallback(cb.id, "Moving…");
  await runMove(chatId, messageId, chat.accts, move.ids, chat.accts[move.from], chat.accts[move.to]);
}

async function runMove(chatId: number, messageId: number, accts: Account[], ids: string[], from: Account, to: Account) {
  const head = `Moving from <b>${h(from.e)}</b> to <b>${h(to.e)}</b>`;
  await edit(chatId, messageId, `${head}…`);
  const start = Date.now();
  let res: TransferResult | null = null;
  let lastEdit = 0;
  const progress = (r: TransferResult) => {
    if (Date.now() - lastEdit < 4000) return;
    lastEdit = Date.now();
    edit(chatId, messageId, `${head}…\n\n${r.moved_so_far} moved so far, ${r.space_freed_so_far} freed.`).catch(() => {});
  };
  try {
    do {
      res = await transfer(accts, res?.state ? { state: res.state, budgetMs: TRANSFER_BUDGET_MS, onProgress: progress } : { ids, from, to, budgetMs: TRANSFER_BUDGET_MS, onProgress: progress });
    } while (!res.done && res.state && Date.now() - start < TRANSFER_MAX_MS);
  } catch (e) {
    await edit(chatId, messageId, `${head}: stopped.\n\n⚠️ ${h(e instanceof Error ? e.message : String(e))}\n\nSend the same /move again to carry on: items already moved are skipped.`);
    return;
  }
  const errs = res.errors.slice(0, 5).map((x) => `• ${h(x.name)}: ${h(x.detail)}`);
  const unfinished = !res.done ? "\n\nIt's a big job and isn't finished yet. Send the same /move again to carry on." : "";
  await edit(chatId, messageId, `${res.done ? "✅" : "⏸"} ${h(res.message)}${errs.length ? `\n\n${errs.join("\n")}` : ""}${unfinished}`);
}
