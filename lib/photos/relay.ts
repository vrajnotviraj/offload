/**
 * The one piece of Offload's Google Photos copy that runs on the server: moving bytes. Browsers can't read the
 * headers Google Photos uses for piece-by-piece downloads (Content-Range) and uploads (X-Goog-Upload-URL), so each
 * call downloads one piece of a picked photo from the source account and hands it straight to the receiving
 * account's upload. Nothing is stored or looked at, and the relay only talks to Google Photos' own addresses.
 * relayChunkToDrive (AI connector only, not reachable over HTTP) does the same into a Google Drive upload instead.
 */

export const CHUNK = 16 * 1024 * 1024; // a multiple of 256 KB, as resumable uploads need
const WHOLE_MAX = 100 * 1024 * 1024; // when Google won't send pieces, the most we take in one go
const LIBRARY_UPLOADS = "https://photoslibrary.googleapis.com/v1/uploads";

export type RelayRequest = {
  src: string; // the picked item's baseUrl
  video: boolean;
  mime: string;
  srcToken: string; // source account, photospicker.mediaitems.readonly
  destToken: string; // receiving account, photoslibrary.appendonly
  upload?: string | null; // resumable upload address, once started
  offset: number;
};

export type RelayResponse =
  | { ok: true; upload: string | null; offset: number; total: number; done: boolean; token?: string }
  | { ok: false; status: number; side: "download" | "upload" | "request"; error: string };

type Fail = Extract<RelayResponse, { ok: false }>;
const bad = (error: string, status = 400, side: Fail["side"] = "request"): Fail => ({ ok: false, status, side, error });

function validSrc(u: string): URL | null {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && (url.hostname === "lh3.googleusercontent.com" || url.hostname.endsWith(".googleusercontent.com")) && !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

function validUpload(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "photoslibrary.googleapis.com" && url.pathname.startsWith("/v1/uploads");
  } catch {
    return false;
  }
}

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

type Piece = { ok: true; bytes: Uint8Array<ArrayBuffer>; total: number; last: boolean; mime: string | null };

/** Downloads the piece of a picked item that starts at `offset`, as the source account. */
async function downloadPiece(src: URL, video: boolean, srcToken: string, offset: number): Promise<Piece | Fail> {
  const down = await fetch(`${src.href}${video ? "=dv" : "=d"}`, {
    headers: { authorization: `Bearer ${srcToken}`, range: `bytes=${offset}-${offset + CHUNK - 1}` },
  });
  if (down.status !== 200 && down.status !== 206) return bad(`Download failed (HTTP ${down.status}).`, down.status, "download");
  let total: number;
  if (down.status === 206) {
    const m = /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(down.headers.get("content-range") || "");
    if (!m || Number(m[1]) !== offset) return bad("Google Photos sent an unexpected piece.", 502, "download");
    total = Number(m[3]);
  } else {
    if (offset) return bad("The download started over halfway through. Pick this one again.", 502, "download");
    const len = Number(down.headers.get("content-length") || 0);
    if (len > WHOLE_MAX) return bad("Too big to copy: Google sent it in one piece, and the most Offload takes in one go is 100 MB.", 413, "download");
    total = len;
  }
  const bytes = new Uint8Array(await down.arrayBuffer());
  if (down.status === 200) total = bytes.length;
  const type = (down.headers.get("content-type") || "").split(";")[0].trim();
  return { ok: true, bytes, total, last: offset + bytes.length >= total, mime: MIME_RE.test(type) && /^(image|video)\//.test(type) ? type : null };
}

/** Checks what every relay call needs; returns the source address and offset, or what's wrong. */
function check(r: { src?: unknown; offset?: unknown; srcToken?: unknown; destToken?: unknown }): { src: URL; offset: number } | Fail {
  const src = validSrc(String(r.src || ""));
  if (!src) return bad("That isn't a Google Photos download address.");
  const offset = Number(r.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) return bad("Bad offset.");
  for (const t of [r.srcToken, r.destToken]) if (typeof t !== "string" || !t || t.length > 4096) return bad("Missing sign-in.");
  return { src, offset };
}

export async function relayChunk(r: RelayRequest): Promise<RelayResponse> {
  if (!r || typeof r !== "object") return bad("Send the request as JSON.");
  const c = check(r);
  if ("ok" in c) return c;
  const { src, offset } = c;
  if (r.upload && !validUpload(r.upload)) return bad("That isn't a Google Photos upload address.");
  const mime = MIME_RE.test(String(r.mime || "")) ? r.mime : "application/octet-stream";

  // 1. one piece from the source account
  const piece = await downloadPiece(src, r.video, r.srcToken, offset);
  if (!piece.ok) return piece;
  const { bytes, total, last } = piece;
  const auth = { authorization: `Bearer ${r.destToken}` };

  // 2. hand it to the receiving account
  if (!offset && last) {
    const up = await fetch(LIBRARY_UPLOADS, {
      method: "POST",
      headers: { ...auth, "content-type": "application/octet-stream", "x-goog-upload-content-type": mime, "x-goog-upload-protocol": "raw" },
      body: bytes,
    });
    if (!up.ok) return bad(`Upload failed (HTTP ${up.status}).`, up.status, "upload");
    return { ok: true, upload: null, offset: bytes.length, total, done: true, token: (await up.text()).trim() };
  }
  let upload = r.upload || null;
  if (!upload) {
    const start = await fetch(LIBRARY_UPLOADS, {
      method: "POST",
      headers: { ...auth, "content-length": "0", "x-goog-upload-command": "start", "x-goog-upload-protocol": "resumable", "x-goog-upload-content-type": mime, "x-goog-upload-raw-size": String(total) },
    });
    upload = start.headers.get("x-goog-upload-url");
    if (!start.ok || !upload || !validUpload(upload)) return bad(`Couldn't start the upload (HTTP ${start.status}).`, start.status || 502, "upload");
  }
  const put = await fetch(upload, {
    method: "POST",
    headers: { ...auth, "content-type": "application/octet-stream", "x-goog-upload-command": last ? "upload, finalize" : "upload", "x-goog-upload-offset": String(offset) },
    body: bytes,
  });
  if (!put.ok) return bad(`Upload failed (HTTP ${put.status}).`, put.status, "upload");
  const next = offset + bytes.length;
  return last ? { ok: true, upload, offset: next, total, done: true, token: (await put.text()).trim() } : { ok: true, upload, offset: next, total, done: false };
}

/* ===================================================================== *
 * Into Google Drive instead (AI connector only)
 * ===================================================================== */

const DRIVE_UPLOADS = "https://www.googleapis.com/upload/drive/v3/files";

export type DriveRelayRequest = {
  src: string; // the picked item's baseUrl
  video: boolean;
  mime: string;
  name: string;
  folder: string; // Drive folder ID the file goes into
  srcToken: string; // source account, photospicker.mediaitems.readonly
  destToken: string; // receiving account, drive
  upload?: string | null; // Drive resumable upload address, once started
  offset: number;
};

export type DriveRelayResponse =
  | { ok: true; upload: string | null; offset: number; total: number; done: boolean; file?: { id: string; name: string; link: string } }
  | Fail;

function validDriveUpload(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "www.googleapis.com" && url.pathname === "/upload/drive/v3/files" && url.searchParams.has("upload_id");
  } catch {
    return false;
  }
}

/**
 * Like relayChunk, but hands each piece to a Drive resumable upload, so the picked photo becomes a file in `folder`.
 * Every file goes through the same resumable upload, small ones in a single piece.
 */
export async function relayChunkToDrive(r: DriveRelayRequest): Promise<DriveRelayResponse> {
  const c = check(r);
  if ("ok" in c) return c;
  const { src, offset } = c;
  if (r.upload && !validDriveUpload(r.upload)) return bad("That isn't a Google Drive upload address.");
  if (!/^(root|[A-Za-z0-9_-]{5,})$/.test(String(r.folder || ""))) return bad("Bad folder.");

  const piece = await downloadPiece(src, r.video, r.srcToken, offset);
  if (!piece.ok) return piece;
  const { bytes, total, last } = piece;
  if (!total) return bad("Google Photos sent an empty file.", 502, "download");
  const auth = { authorization: `Bearer ${r.destToken}` };

  let upload = r.upload || null;
  if (!upload) {
    const mime = piece.mime || (MIME_RE.test(String(r.mime || "")) ? r.mime : "application/octet-stream");
    const name = String(r.name || "photo").slice(0, 255);
    const start = await fetch(`${DRIVE_UPLOADS}?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json; charset=UTF-8", "x-upload-content-type": mime, "x-upload-content-length": String(total) },
      body: JSON.stringify({ name, mimeType: mime, parents: [r.folder] }),
    });
    upload = start.headers.get("location");
    if (!start.ok || !upload || !validDriveUpload(upload)) return bad(`Couldn't start the Drive upload (HTTP ${start.status}).`, start.status || 502, "upload");
  }
  const end = offset + bytes.length - 1;
  // Drive answers 308 to every piece but the last; "manual" keeps fetch from treating that as a redirect.
  const put = await fetch(upload, {
    method: "PUT",
    redirect: "manual",
    headers: { ...auth, "content-range": `bytes ${offset}-${end}/${total}` },
    body: bytes,
  });
  const next = offset + bytes.length;
  if (put.status === 308) {
    if (last) return bad("Google Drive didn't finish the upload.", 502, "upload");
    return { ok: true, upload, offset: next, total, done: false };
  }
  if (!put.ok) return bad(`Drive upload failed (HTTP ${put.status}).`, put.status, "upload");
  const f = await put.json().catch(() => null);
  if (!f?.id) return bad("Google Drive didn't say which file it made.", 502, "upload");
  return {
    ok: true,
    upload,
    offset: next,
    total,
    done: true,
    file: { id: String(f.id), name: String(f.name || r.name), link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view` },
  };
}
