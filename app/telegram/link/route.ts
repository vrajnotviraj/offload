import { googleRedirect, page } from "@/lib/mcp/oauth";
import type { Flow } from "@/lib/mcp/oauth";
import { open } from "@/lib/mcp/seal";
import { linkStartPage } from "@/lib/telegram/link";

/** Opened from the Telegram bot's /link button: explains the sign-in, then sends the person to Google. */
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  const state = new URL(req.url).searchParams.get("state") || "";
  const flow = open<Flow>("flow", state);
  if (!flow?.p.tg) {
    return page({ title: "This link expired", body: "<p>Send /link to the Offload bot in Telegram to get a new one.</p>" });
  }
  return linkStartPage(googleRedirect(req), state);
}
