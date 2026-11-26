import { waitlist } from "@/lib/access/sheet";

/** The waitlist form (/waitlist): adds an email, and an optional name, to the Waitlist tab of the sheet. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return Response.json({ error: "Not allowed." }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  // A hidden field people don't see: bots that fill every field get a quiet "done".
  if (body.website) return Response.json({ status: "waitlist", position: 0 });
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!EMAIL_RE.test(email) || email.length > 254) return Response.json({ error: "That doesn't look like an email address." }, { status: 400 });
  try {
    // A leading = + - @ would make the sheet treat the name as a formula; the sheet is written RAW, but keep it plain anyway.
    const r = await waitlist(email, "Waitlist form", name.replace(/^[=+\-@]+/, ""));
    return Response.json(r, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("Waitlist sign-up failed:", e);
    return Response.json({ error: "Couldn't add you to the waitlist just now. Try again in a minute." }, { status: 503 });
  }
}
