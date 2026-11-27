import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Account } from "@/lib/drive/api";
import { open, seal } from "@/lib/mcp/seal";

/**
 * What the Telegram bot remembers per chat: the linked Google accounts, the last list of files it showed
 * (so "/move 1 3" knows what 1 and 3 are) and a move waiting for the Confirm button.
 *
 * Unlike the MCP connector, Telegram can't hand a sealed token back with every message, so the bot needs somewhere
 * to keep it. It's one JSON file in TELEGRAM_DATA_DIR (default ./.data). On Railway, mount a volume there, or every
 * deploy signs everyone out. Each chat's record is sealed with MCP_TOKEN_SECRET, so the file holds no readable tokens.
 */

export type ListedItem = { id: string; name: string; size: string; bytes: number; folder: boolean; acct: number };
export type PendingMove = { nonce: string; ids: string[]; names: string[]; bytes: number; from: number; to: number };
export type Chat = { accts: Account[]; last?: ListedItem[]; move?: PendingMove };

const dir = () => process.env.TELEGRAM_DATA_DIR || path.join(process.cwd(), ".data");
const file = () => path.join(dir(), "telegram.json");

let cache: Record<string, string> | null = null;
let writing: Promise<void> = Promise.resolve();

async function load(): Promise<Record<string, string>> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(file(), "utf8"));
  } catch {
    cache = {};
  }
  return cache!;
}

/** Writes one at a time, through a temp file, so a crash never leaves half a file. */
function persist() {
  writing = writing.then(async () => {
    await mkdir(dir(), { recursive: true });
    const tmp = `${file()}.tmp`;
    await writeFile(tmp, JSON.stringify(cache), { mode: 0o600 });
    await rename(tmp, file());
  });
  return writing;
}

export async function getChat(chatId: number): Promise<Chat | null> {
  const all = await load();
  const c = open<Chat>("tgchat", all[String(chatId)]);
  return c && Array.isArray(c.accts) && c.accts.length ? c : null;
}

export async function saveChat(chatId: number, chat: Chat) {
  const all = await load();
  all[String(chatId)] = seal("tgchat", chat);
  await persist();
}

export async function deleteChat(chatId: number) {
  const all = await load();
  delete all[String(chatId)];
  await persist();
}
