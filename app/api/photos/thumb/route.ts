/**
 * A small preview of one picked Google Photos item, for the web app's tagging grid (components/app/PhotoTagger.tsx).
 * The browser tries Google directly first and only comes here if that's blocked. It fetches the preview as the source
 * account and hands the image straight back: nothing is stored or looked at, and it only talks to Google's photo
 * addresses (*.googleusercontent.com).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validSrc(u: string): URL | null {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname.endsWith(".googleusercontent.com") && !url.hash && !url.search ? url : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return new Response("Not allowed.", { status: 403 });
  const { src, token, px } = await req.json().catch(() => ({}));
  const url = validSrc(String(src || ""));
  const size = Math.min(512, Math.max(64, Math.round(Number(px) || 256)));
  if (!url || typeof token !== "string" || !token || token.length > 4096) return new Response("Bad request.", { status: 400 });
  const res = await fetch(`${url.href}=w${size}-h${size}-c`, { headers: { authorization: `Bearer ${token}` } });
  const type = res.headers.get("content-type") || "";
  if (!res.ok || !type.startsWith("image/")) return new Response("Google didn't send a preview.", { status: res.status === 200 ? 502 : res.status });
  return new Response(res.body, { headers: { "content-type": type, "cache-control": "private, no-store" } });
}
