import { admit, waitlistMessage } from "@/lib/access/sheet";

/**
 * Early access for the web app: the browser sends the Google access token of the first account someone signs in with.
 * The server checks with Google that the token was issued to Offload and which account it's for, then lets the person in
 * or puts them on the waitlist (lib/access/sheet.ts). The token is only used for those two checks and isn't kept.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return Response.json({ error: "Not allowed." }, { status: 403 });
  const { token } = await req.json().catch(() => ({}));
  if (typeof token !== "string" || !token || token.length > 4096) return Response.json({ error: "Send the token." }, { status: 400 });

  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`).then((r) => r.json().catch(() => ({})));
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!info || (info.aud !== clientId && info.azp !== clientId)) return Response.json({ error: "That sign-in isn't Offload's." }, { status: 401 });
  const about = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
    headers: { authorization: `Bearer ${token}` },
  }).then((r) => r.json().catch(() => ({})));
  const email = String(about?.user?.emailAddress || "").toLowerCase();
  if (!email) return Response.json({ error: "Google didn't say which account that was." }, { status: 401 });

  const a = await admit(email, "Web app");
  return Response.json(
    a.status === "in" ? { status: "in" } : { status: "waitlist", position: a.position, message: waitlistMessage(email, a.position) },
    { headers: { "cache-control": "no-store" } }
  );
}
