import { callGoogle, drive, DRIVE_SCOPE, LIBRARY_SCOPE, PICKER_SCOPE, type Account } from "@/lib/drive/api";
import { count, createFolder, human } from "@/lib/drive/engine";
import { listPicked, MAX_PICK, pollPicking, startPicking, type Picked } from "./engine";
import { relayChunk, relayChunkToDrive } from "./relay";

/**
 * Photos for the AI connector (server side).
 *
 * Two kinds of photos, because Google treats them differently:
 * - Photos and videos stored in Google Drive: Offload can read them all with its Drive access, so it can build a full
 *   month-by-month and year-by-year timeline and show previews of any of them.
 * - Google Photos: since March 2025 Google lets apps see only the photos a person picks in Google's own picker
 *   (Photos Picker API). So the person picks (up to 2,000 at a time, from a link), and Offload can then build a timeline of
 *   the picked ones, show previews, and copy them into another linked account's Google Photos (Photos Library API, add-only).
 */

const LIBRARY = "https://photoslibrary.googleapis.com/v1";
const MEDIA_Q = "'me' in owners and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/')";
const MEDIA_FIELDS =
  "nextPageToken,files(id,mimeType,size,quotaBytesUsed,createdTime,imageMediaMetadata(time,cameraMake,cameraModel),videoMediaMetadata(durationMillis))";
/** Sample IDs kept per month, so a person can ask to see photos from any month. */
const SAMPLES = 4;
const MAX_CAMERAS = 40;
const PREVIEW_PX = 400;
export const MAX_PREVIEWS = 12;

/* ===================================================================== *
 * Permissions
 * ===================================================================== */

const RECONNECT =
  "Remove Offload in your AI app's connector settings, add it again, and leave the Google Photos boxes ticked on Google's screen.";

export function requirePicker(acct: Account) {
  if (!acct.ph?.includes("p")) {
    throw new Error(`${acct.e} hasn't allowed Offload to use the Google Photos picker (connections made before Google Photos support don't have it). ${RECONNECT}`);
  }
}

export function requireLibrary(acct: Account) {
  if (!acct.ph?.includes("a")) {
    throw new Error(`${acct.e} hasn't allowed Offload to add photos to its Google Photos. ${RECONNECT}`);
  }
}

/* ===================================================================== *
 * New albums
 * ===================================================================== */

/**
 * Makes an empty album in `acct`'s Google Photos. Add-only access means Offload can fill it only with photos it adds
 * itself (copy_google_photos with album_id, then add_to_photos_album); the person can add any of their own photos to
 * it in Google Photos.
 */
export async function createAlbum(acct: Account, title: string) {
  requireLibrary(acct);
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("Give the album a name.");
  if (clean.length > 500) throw new Error("Album names can be at most 500 characters.");
  const a = await callGoogle(LIBRARY, LIBRARY_SCOPE, acct, "POST", "albums", {}, { album: { title: clean } });
  return {
    message:
      `Made an empty album "${clean}" in ${acct.e}'s Google Photos. ` +
      "Offload can fill it with photos it copies into this account (copy_google_photos with this album_id, or add_to_photos_album for copies " +
      "it already made). Photos that were already in the account have to be added in Google Photos (open the album and choose Add photos).",
    account: acct.e,
    album_id: String(a.id),
    title: clean,
    link: a.productUrl || "",
  };
}

/* ===================================================================== *
 * Timelines
 * ===================================================================== */

/** [photos, videos, bytes, video milliseconds] for one month, "YYYY-MM". */
type Bucket = [number, number, number, number];
type Sample = [string, number]; // [file or item id, index of the account it's in]

export type Tally = {
  months: Record<string, Bucket>;
  samples: Record<string, Sample[]>;
  cameras: Record<string, number>;
  /** Per linked account (index): [photos, videos, bytes]. */
  accts: Record<string, [number, number, number]>;
};

export const emptyTally = (): Tally => ({ months: {}, samples: {}, cameras: {}, accts: {} });

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;

/** "2019:07:14 10:22:01" (EXIF) or an ISO date → "2019-07", or null if there's no real date. */
function monthKey(t?: string): string | null {
  const m = /^(\d{4})[:-](\d{2})/.exec(t || "");
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12) return null;
  return `${m[1]}-${m[2]}`;
}

function add(t: Tally, o: { month: string; video: boolean; bytes: number; ms: number; camera?: string; sample: Sample; acct: number }) {
  const b = (t.months[o.month] ||= [0, 0, 0, 0]);
  b[o.video ? 1 : 0]++;
  b[2] += o.bytes;
  b[3] += o.ms;
  const s = (t.samples[o.month] ||= []);
  if (s.length < SAMPLES) s.push(o.sample);
  if (o.camera) {
    if (t.cameras[o.camera] !== undefined || Object.keys(t.cameras).length < MAX_CAMERAS) t.cameras[o.camera] = (t.cameras[o.camera] || 0) + 1;
  }
  const a = (t.accts[o.acct] ||= [0, 0, 0]);
  a[o.video ? 1 : 0]++;
  a[2] += o.bytes;
}

const duration = (ms: number) => {
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};

/**
 * Turns a tally into what the AI shows: totals, one row per year, and one row per month (newest first).
 * `withSize` is false for Google Photos picks, which come without file sizes.
 */
export function summarize(t: Tally, accounts: Account[], o: { group_by: "month" | "year"; withSize: boolean; samples: boolean }) {
  const keys = Object.keys(t.months).sort().reverse();
  const tot: Bucket = [0, 0, 0, 0];
  const years: Record<string, Bucket> = {};
  for (const k of keys) {
    const b = t.months[k];
    const y = (years[k.slice(0, 4)] ||= [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) {
      tot[i] += b[i];
      y[i] += b[i];
    }
  }
  const row = (period: string, label: string, b: Bucket, extra: object = {}) => ({
    period,
    label,
    photos: b[0],
    videos: b[1],
    ...(o.withSize ? { size: human(b[2]) } : {}),
    ...(b[3] ? { video_length: duration(b[3]) } : {}),
    ...extra,
  });
  const sampleOf = (k: string) =>
    o.samples && t.samples[k]?.length
      ? { preview_ids: t.samples[k].map(([id, a]) => (accounts.length > 1 ? { id, account: accounts[a]?.e || "" } : { id })) }
      : {};
  const yearRows = Object.keys(years)
    .sort()
    .reverse()
    .map((y) => row(y, y, years[y], { months_with_photos: keys.filter((k) => k.startsWith(y)).length }));
  const monthRows = keys.map((k) => row(k, monthName(k), t.months[k], sampleOf(k)));

  const items = tot[0] + tot[1];
  const busiestMonth = [...keys].sort((a, b) => t.months[b][0] + t.months[b][1] - (t.months[a][0] + t.months[a][1]))[0];
  const busiestYear = Object.keys(years).sort((a, b) => years[b][0] + years[b][1] - (years[a][0] + years[a][1]))[0];
  const cameras = Object.entries(t.cameras)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, n]) => ({ camera: name, items: n }));
  const perAccount = Object.entries(t.accts).map(([i, [p, v, bytes]]) => ({
    account: accounts[Number(i)]?.e || "",
    photos: p,
    videos: v,
    ...(o.withSize ? { size: human(bytes) } : {}),
  }));

  return {
    items,
    totals: {
      photos: tot[0],
      videos: tot[1],
      ...(o.withSize ? { size: human(tot[2]) } : {}),
      ...(tot[3] ? { video_length: duration(tot[3]) } : {}),
      ...(keys.length ? { from: monthName(keys[keys.length - 1]), to: monthName(keys[0]) } : {}),
      ...(busiestMonth ? { busiest_month: `${monthName(busiestMonth)} (${count(t.months[busiestMonth][0] + t.months[busiestMonth][1], "item")})` } : {}),
      ...(busiestYear ? { busiest_year: `${busiestYear} (${count(years[busiestYear][0] + years[busiestYear][1], "item")})` } : {}),
    },
    ...(perAccount.length > 1 ? { per_account: perAccount } : {}),
    ...(cameras.length ? { cameras } : {}),
    by_year: yearRows,
    ...(o.group_by === "month" ? { by_month: monthRows } : {}),
  };
}

function headline(s: ReturnType<typeof summarize>, where: string, withSize: boolean) {
  if (!s.items) return `No photos or videos ${where}.`;
  const t = s.totals;
  const parts = [
    `${count(t.photos, "photo")} and ${count(t.videos, "video")} ${where}` + (withSize && "size" in t ? ` (${t.size})` : "") +
      ("from" in t ? `, from ${t.from} to ${t.to}` : "") + ".",
  ];
  if ("busiest_year" in t) parts.push(`Busiest year: ${t.busiest_year}; busiest month: ${t.busiest_month}.`);
  return parts.join(" ");
}

/* ===================================================================== *
 * Photos and videos in Google Drive
 * ===================================================================== */

export type DriveTimelineState = { k: "dtl"; a: number[]; tok: string | null; t: Tally; seen: number };

/** Scans every photo and video the accounts own in Drive, for up to `budgetMs`. Call again with the state until it's gone. */
export async function driveTimeline(accounts: Account[], targets: number[], prev: DriveTimelineState | undefined, budgetMs: number) {
  const st: DriveTimelineState = prev || { k: "dtl", a: [...targets], tok: null, t: emptyTally(), seen: 0 };
  const start = Date.now();
  let pages = 0; // always read at least one page, so every call makes progress
  while (st.a.length && (!pages++ || Date.now() - start < budgetMs)) {
    const idx = st.a[0];
    const acct = accounts[idx];
    if (!acct) {
      st.a.shift();
      continue;
    }
    const res = await drive(acct, "GET", "files", { q: MEDIA_Q, pageSize: 1000, pageToken: st.tok || undefined, fields: MEDIA_FIELDS });
    for (const f of res.files || []) {
      const img = f.imageMediaMetadata || {};
      const month = monthKey(img.time) || monthKey(f.createdTime);
      if (!month) continue;
      const camera = [img.cameraMake, img.cameraModel].filter(Boolean).join(" ").trim();
      add(st.t, {
        month,
        video: String(f.mimeType).startsWith("video/"),
        bytes: Number(f.quotaBytesUsed || f.size || 0),
        ms: Number(f.videoMediaMetadata?.durationMillis || 0),
        camera: camera || undefined,
        sample: [f.id, idx],
        acct: idx,
      });
      st.seen++;
    }
    st.tok = res.nextPageToken || null;
    if (!st.tok) st.a.shift();
  }
  return st;
}

export function driveTimelineResult(st: DriveTimelineState, accounts: Account[], targets: number[], group_by: "month" | "year") {
  const done = !st.a.length;
  const where = targets.length === 1 ? `in ${accounts[targets[0]].e}'s Google Drive` : "in Google Drive across your linked accounts";
  if (!done) {
    return {
      message: `Still counting: ${count(st.seen, "photo or video", "photos and videos")} so far ${where}. Carrying on…`,
      done: false,
    };
  }
  const s = summarize(st.t, accounts, { group_by, withSize: true, samples: group_by === "month" });
  return {
    message: headline(s, where, true),
    done: true,
    source: "google_drive",
    ...s,
    note:
      "Dates are when each photo was taken where the file says so, otherwise when it was added to Drive. " +
      "These are photos and videos stored in Google Drive; the Google Photos library is separate (use pick_google_photos for it). " +
      (group_by === "month" ? "preview_ids can be passed to show_photos." : ""),
  };
}

/* ===================================================================== *
 * Google Photos: picking
 * ===================================================================== */

/** A picking session, as handed to the AI: whose Google Photos it is, and Google's session id. */
export type PickToken = { k: "pick"; a: number; id: string };

export async function startPick(accounts: Account[], idx: number) {
  const acct = accounts[idx];
  requirePicker(acct);
  const s = await startPicking(acct);
  return { token: { k: "pick", a: idx, id: s.id } as PickToken, url: s.uri };
}

/** Whether the person has finished picking, and if so everything they picked. */
export async function picked(accounts: Account[], tok: PickToken): Promise<{ ready: false } | { ready: true; items: Picked[] }> {
  const acct = accounts[tok.a];
  if (!acct) throw new Error("That photos_session belongs to a different connection. Start again with pick_google_photos.");
  requirePicker(acct);
  const s = await pollPicking(acct, tok.id);
  if (!s.ready) return { ready: false };
  return { ready: true, items: await listPicked(acct, tok.id) };
}

export function pickedTally(items: Picked[], acctIdx: number): Tally {
  const t = emptyTally();
  items.forEach((it, i) => {
    const month = monthKey(it.time);
    if (!month) return;
    add(t, { month, video: it.video, bytes: 0, ms: 0, camera: it.camera, sample: [String(i), acctIdx], acct: acctIdx });
  });
  return t;
}

export function pickedResult(items: Picked[], accounts: Account[], acctIdx: number, group_by: "month" | "year") {
  const s = summarize(pickedTally(items, acctIdx), accounts, { group_by, withSize: false, samples: false });
  const where = `picked from ${accounts[acctIdx].e}'s Google Photos`;
  return {
    message: headline(s, where, false),
    source: "google_photos_picked",
    ...s,
    note:
      `Google only lets apps see the photos a person picks (up to ${MAX_PICK.toLocaleString("en-US")} at a time), so this covers the picked ones, not the whole library. ` +
      "Google Photos doesn't give file sizes for picked items. Pass this photos_session to show_photos (optionally with a period such as 2019 or 2019-07) to see them, or to copy_google_photos to copy them to another account.",
  };
}

/** The picked items in `period` ("2019" or "2019-07"), or all of them. */
export function inPeriod(items: Picked[], period?: string) {
  if (!period) return items;
  return items.filter((it) => (monthKey(it.time) || "").startsWith(period));
}

/* ===================================================================== *
 * Previews
 * ===================================================================== */

/** `item` = its number in the picked set (Google Photos picks only), the number copy_google_photos takes. */
export type Preview = { item?: number; name: string; taken?: string; account: string; video: boolean; data: string; mime: string };

async function fetchImage(url: string, token: string): Promise<{ data: string; mime: string } | null> {
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (!mime.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 1_500_000) return null;
    return { data: buf.toString("base64"), mime };
  } catch {
    return null;
  }
}

/** Small previews of picked Google Photos items (videos show their first frame). `nums` = each one's number in the picked set. */
export async function pickedPreviews(
  acct: Account,
  items: Picked[],
  token: (a: Account, scope: string) => Promise<string>,
  nums: number[] = []
): Promise<Preview[]> {
  const t = await token(acct, PICKER_SCOPE);
  const out = await Promise.all(
    items.map(async (it, i): Promise<Preview | null> => {
      const img = await fetchImage(`${it.url}=w${PREVIEW_PX}-h${PREVIEW_PX}`, t);
      return img ? { ...(nums[i] ? { item: nums[i] } : {}), name: it.name, taken: it.time, account: acct.e, video: it.video, ...img } : null;
    })
  );
  return out.filter((x): x is Preview => !!x);
}

const ID_RE = /^[A-Za-z0-9_-]{5,}$/;

/** Small previews of Drive photos and videos by file ID. Each ID is looked up in `accounts` until one can see it. */
export async function drivePreviews(accounts: Account[], ids: string[], token: (a: Account) => Promise<string>) {
  const missing: string[] = [];
  const out = await Promise.all(
    ids.map(async (id) => {
      if (!ID_RE.test(id)) {
        missing.push(id);
        return null;
      }
      for (const acct of accounts) {
        try {
          const f = await drive(acct, "GET", `files/${id}`, {
            fields: "id,name,mimeType,thumbnailLink,createdTime,imageMediaMetadata(time)",
            supportsAllDrives: true,
          });
          if (!f.thumbnailLink) break;
          const url = String(f.thumbnailLink).replace(/=s\d+$/, `=s${PREVIEW_PX}`);
          const img = await fetchImage(url, await token(acct));
          if (!img) break;
          const taken = monthKey(f.imageMediaMetadata?.time) ? String(f.imageMediaMetadata.time).replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3") : f.createdTime;
          return { name: f.name, taken, account: acct.e, video: String(f.mimeType).startsWith("video/"), ...img } as Preview;
        } catch {
          /* not in this account: try the next */
        }
      }
      missing.push(id);
      return null;
    })
  );
  return { previews: out.filter((x): x is Preview => !!x), missing };
}

/* ===================================================================== *
 * Google Photos: copying picked items to another account (its Google Photos or its Drive)
 * ===================================================================== */

/** Where a copy job has got to. `next` is the next position in the order to start; `open` are items stopped halfway. */
export type CopyState = {
  k: "pcopy";
  a: number; // source account
  to: number; // receiving account
  id: string; // picking session
  /** Where the copies go. Missing on tokens from before Drive copies: Google Photos. */
  dest?: "photos" | "drive";
  /** Which picked items to copy (0-based positions in the picked set), in order. Missing or null: all of them. */
  pick?: number[] | null;
  next: number;
  open: { i: number; up: string | null; off: number }[];
  /** Google Photos: the album the copies go into. `own` = the person chose it (album_id), so it's not replaced. */
  album: { id: string; url: string; title?: string; own?: boolean } | null;
  /** Google Photos: the name for the album Offload makes on the first call, if not "Copied from <source>". */
  albumTitle?: string;
  /** Google Photos: why the album couldn't be used, if it couldn't. */
  albumLost?: string;
  /** Drive: the folder the copies go into. Made on the first call if the person didn't choose one. */
  folder?: { id: string; name: string; link: string } | null;
  total: number;
  copied: number;
  failed: number;
  bytes: number;
  errors: { name: string; detail: string }[];
};

/** One finished copy, as handed to the AI: its number in the picked set and the new item's ID. */
export type Made = { item: number; name: string; id: string; link?: string };

const BATCH = 50;
const PARALLEL = 4;

/**
 * Copies picked items from the source account's Google Photos into `to`'s Google Photos (into an album) or `to`'s
 * Drive (into a folder), for up to `budgetMs`. Big videos can stop halfway and carry on next call. Originals stay
 * where they are, and the picking session is left open, so the same pick can be copied again somewhere else (Google
 * expires it on its own).
 */
export async function copyPickedServer(
  accounts: Account[],
  st: CopyState,
  budgetMs: number,
  token: (a: Account, scope: string, force?: boolean) => Promise<string>
) {
  const from = accounts[st.a];
  const to = accounts[st.to];
  if (!from || !to) throw new Error("That copy belongs to a different connection. Start again with pick_google_photos.");
  const toDrive = st.dest === "drive";
  const destScope = toDrive ? DRIVE_SCOPE : LIBRARY_SCOPE;
  requirePicker(from);
  if (!toDrive) requireLibrary(to);
  const items = await listPicked(from, st.id);
  const order = st.pick || null;
  const positions = order ? order.length : items.length;
  st.total = positions;
  const start = Date.now();
  let progressed = false; // every call copies at least one piece before it can stop
  const outOfTime = () => progressed && Date.now() - start > budgetMs;
  const work = st.next < positions || st.open.length > 0;
  const albumName = () => st.album?.title || st.albumTitle || `Copied from ${from.e}`;

  if (work && !toDrive && !st.album && !st.albumLost) {
    const title = albumName();
    try {
      const a = await callGoogle(LIBRARY, LIBRARY_SCOPE, to, "POST", "albums", {}, { album: { title } });
      st.album = { id: a.id, url: a.productUrl || "", title };
    } catch {
      st.album = null; // copy without an album rather than not at all
      st.albumLost = `Google Photos wouldn't make the album "${title}", so the copies are in the library without an album.`;
    }
  }
  if (work && toDrive && !st.folder) {
    const f = await createFolder(to, `Copied from ${from.e} (Google Photos)`);
    st.folder = { id: f.folder_id, name: f.name, link: f.link };
  }

  const made: Made[] = [];
  const fail = (it: Picked | undefined, detail: string) => {
    st.failed++;
    if (st.errors.length < 10) st.errors.push({ name: it?.name || "an item", detail });
  };
  const ready: { i: number; it: Picked; token: string }[] = [];
  const stopped: CopyState["open"] = [];
  const queue = [...st.open];
  st.open = [];

  const copyOne = async (job: { i: number; up: string | null; off: number }) => {
    const it = items[job.i];
    if (!it) return fail(undefined, "It's no longer in the picked set.");
    let up = job.up;
    let off = job.off;
    let retried = false;
    for (;;) {
      if (outOfTime() && off > 0) {
        stopped.push({ i: job.i, up, off });
        return;
      }
      const common = {
        src: it.url,
        video: it.video,
        mime: it.mime,
        srcToken: await token(from, PICKER_SCOPE),
        destToken: await token(to, destScope),
        upload: up,
        offset: off,
      };
      const r = toDrive ? await relayChunkToDrive({ ...common, name: it.name, folder: st.folder!.id }) : await relayChunk(common);
      if (!r.ok) {
        if (r.status === 401 && !retried) {
          retried = true; // the sign-in ran out: get a fresh one and try that piece again
          if (r.side === "upload") await token(to, destScope, true);
          else await token(from, PICKER_SCOPE, true);
          continue;
        }
        return fail(it, r.error);
      }
      progressed = true;
      up = r.upload;
      off = r.offset;
      if (r.done) {
        st.bytes += r.total;
        if ("file" in r && r.file) {
          st.copied++;
          made.push({ item: job.i + 1, name: r.file.name, id: r.file.id, link: r.file.link });
        } else ready.push({ i: job.i, it, token: ("token" in r && r.token) || "" });
        return;
      }
    }
  };

  const worker = async () => {
    for (;;) {
      if (outOfTime()) return;
      let job = queue.shift();
      if (!job && st.next < positions) {
        const pos = st.next++;
        job = { i: order ? order[pos] : pos, up: null, off: 0 };
      }
      if (!job) return;
      try {
        await copyOne(job);
      } catch (e) {
        fail(items[job.i], e instanceof Error ? e.message : String(e));
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  st.open = [...queue, ...stopped];

  // Google Photos: add everything uploaded in this call to the library, 50 at a time.
  for (let i = 0; i < ready.length; i += BATCH) {
    const batch = ready.slice(i, i + BATCH);
    const body: any = { newMediaItems: batch.map((b) => ({ simpleMediaItem: { uploadToken: b.token, fileName: b.it.name } })) };
    if (st.album) body.albumId = st.album.id;
    let res: any;
    try {
      try {
        res = await callGoogle(LIBRARY, LIBRARY_SCOPE, to, "POST", "mediaItems:batchCreate", {}, body);
      } catch (e) {
        if (!body.albumId) throw e;
        // The album may have been deleted or, if the person chose it, not made by Offload: add them without it.
        delete body.albumId;
        st.albumLost = st.album?.own
          ? "Google Photos wouldn't add them to the album you chose (Offload can only fill albums it made itself), so they're in the library without an album."
          : `The album "${albumName()}" has gone, so the rest are in the library without an album.`;
        st.album = null;
        res = await callGoogle(LIBRARY, LIBRARY_SCOPE, to, "POST", "mediaItems:batchCreate", {}, body);
      }
    } catch (e) {
      for (const b of batch) fail(b.it, `Google Photos didn't add it: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const byToken = new Map<string, any>((res.newMediaItemResults || []).map((r: any) => [r.uploadToken, r]));
    for (const b of batch) {
      const m = byToken.get(b.token)?.mediaItem;
      if (m?.id) {
        st.copied++;
        made.push({ item: b.i + 1, name: m.filename || b.it.name, id: String(m.id), ...(m.productUrl ? { link: m.productUrl } : {}) });
      } else fail(b.it, byToken.get(b.token)?.status?.message || "Google Photos didn't accept it.");
    }
  }

  const done = st.next >= positions && !st.open.length;
  const finished = st.copied + st.failed;
  const where = toDrive
    ? `${to.e}'s Google Drive` + (st.folder ? `, in the folder "${st.folder.name}"` : "")
    : `${to.e}'s Google Photos` + (st.album ? `, in the album "${albumName()}"` : "");
  const message = done
    ? [
        st.copied ? `Copied ${count(st.copied, "photo or video", "photos and videos")} (${human(st.bytes)}) from ${from.e} to ${where}.` : `Nothing was copied to ${to.e}.`,
        ...(st.albumLost && !toDrive ? [st.albumLost] : []),
        ...(st.failed ? [`${count(st.failed, "item")} couldn't be copied.`] : []),
        ...(st.copied
          ? [
              toDrive
                ? `The originals are still in ${from.e}'s Google Photos, and the copies use ${to.e}'s storage.`
                : `The originals are still in ${from.e}. Check the copies, then delete the originals in Google Photos to free the space there.`,
            ]
          : []),
      ].join(" ")
    : `Still copying to ${to.e}: ${finished.toLocaleString("en-US")} of ${count(st.total, "item")} done (${human(st.bytes)}). Carrying on…`;
  return { done, message, made };
}

export function copyResult(st: CopyState, accounts: Account[], done: boolean, message: string, made: Made[]) {
  const toDrive = st.dest === "drive";
  return {
    message,
    done,
    from: accounts[st.a]?.e,
    to: accounts[st.to]?.e,
    copied_into: toDrive ? "google_drive" : "google_photos",
    total: st.total,
    copied: st.copied,
    failed: st.failed,
    copied_size: human(st.bytes),
    ...(!toDrive && st.album ? { album_id: st.album.id, album_title: st.album.title, ...(st.album.url ? { album: st.album.url } : {}) } : {}),
    ...(toDrive && st.folder ? { folder_id: st.folder.id, folder_name: st.folder.name, folder: st.folder.link } : {}),
    ...(made.length
      ? {
          copies: [...made].sort((x, y) => x.item - y.item),
          copies_note: toDrive
            ? "The new Drive files from this call (item = its number in the picked set). Pass their ids to add_to_drive_folder to put them in more folders."
            : "The new Google Photos items from this call (item = its number in the picked set). Keep these ids: add_to_photos_album needs them to put the copies in more albums." +
              (done ? "" : " Each later call lists the copies it makes."),
        }
      : {}),
    ...(st.errors.length ? { problems: st.errors } : {}),
  };
}

/* ===================================================================== *
 * Google Photos: adding Offload's copies to more albums
 * ===================================================================== */

const MEDIA_ID_RE = /^[A-Za-z0-9_-]{10,}$/;

/**
 * Adds media items to an album, all in `acct`'s Google Photos. Google allows it only when Offload made both the album
 * (create_photos_album or copy_google_photos) and the items (copy_google_photos). An item can be in many albums
 * without using more storage. Google adds a batch all or nothing, so a batch that fails is retried one by one to find
 * the items it won't take.
 */
export async function addToAlbum(acct: Account, albumId: string, ids: string[]) {
  requireLibrary(acct);
  if (!MEDIA_ID_RE.test(albumId)) throw new Error(`${albumId} isn't an album ID. create_photos_album and copy_google_photos return album_id.`);
  const want = [...new Set(ids.map((x) => x.trim()).filter(Boolean))];
  const good = want.filter((x) => MEDIA_ID_RE.test(x));
  if (!good.length) throw new Error("Pass media_item_ids: the ids in copy_google_photos's copies.");
  const refused: { id: string; detail: string }[] = want.filter((x) => !MEDIA_ID_RE.test(x)).map((id) => ({ id, detail: "That isn't a media item ID." }));
  const add = (batch: string[]) =>
    callGoogle(LIBRARY, LIBRARY_SCOPE, acct, "POST", `albums/${encodeURIComponent(albumId)}:batchAddMediaItems`, {}, { mediaItemIds: batch });
  const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
  let added = 0;
  for (let i = 0; i < good.length; i += BATCH) {
    const batch = good.slice(i, i + BATCH);
    try {
      await add(batch);
      added += batch.length;
      continue;
    } catch (e) {
      if (batch.length === 1) {
        refused.push({ id: batch[0], detail: reason(e) });
        continue;
      }
    }
    for (const id of batch) {
      try {
        await add([id]);
        added++;
      } catch (e) {
        refused.push({ id, detail: reason(e) });
      }
    }
  }
  const why =
    "Google only lets Offload add photos it copied itself (the ids from copy_google_photos) to albums it made itself " +
    `(create_photos_album or copy_google_photos), both in the same account (${acct.e}).`;
  const message = added
    ? `Added ${count(added, "photo or video", "photos and videos")} to the album in ${acct.e}'s Google Photos. ` +
      "They use no extra storage: it's the same copy in another album." +
      (refused.length ? ` ${count(refused.length, "item")} couldn't be added. ${why}` : "")
    : `Nothing was added to the album. ${why}`;
  return { message, account: acct.e, album_id: albumId, added, ...(refused.length ? { not_added: refused.slice(0, 20) } : {}) };
}
