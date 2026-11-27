import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { origin } from "@/lib/mcp/oauth";
import { handleUpdate, type Update } from "@/lib/telegram/bot";

/**
 * Webhook for the Offload Telegram bot. Telegram posts every message here; register it once with setWebhook
 * (see the README), passing TELEGRAM_WEBHOOK_SECRET as secret_token so only Telegram can call it.
 * The reply goes out after the 200, so long moves don't make Telegram resend the update.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fromTelegram(req: Request): boolean {
  const want = process.env.TELEGRAM_WEBHOOK_SECRET;
  const got = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!want) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!fromTelegram(req)) return new Response("Forbidden", { status: 403 });
  const update = (await req.json().catch(() => null)) as Update | null;
  if (!update) return new Response("ok");
  const site = origin(req);
  after(() => handleUpdate(update, site).catch((e) => console.error("telegram update failed", e)));
  return new Response("ok");
}
