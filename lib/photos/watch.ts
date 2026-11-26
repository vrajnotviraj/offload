import { drive, DriveError, type Account } from "@/lib/drive/api";
import { human } from "@/lib/drive/engine";

/**
 * Watching for new events in Google Photos.
 *
 * Google doesn't tell apps what's new in someone's Google Photos library, and Offload keeps no database. What it can see
 * is each account's storage: Drive's about.storageQuota gives `usage` and `usageInDrive`, and the rest (usage minus
 * Drive) is Google Photos plus Gmail. Gmail rarely grows by 100 MB in a day, so a jump that size almost always means a
 * batch of new photos and videos: a trip, a wedding, a party. That's what's called an "event" here.
 *
 * Each account remembers its own figure in a small private note in its Drive's application data folder (appDataFolder):
 * a metadata-only file whose appProperties hold the numbers. Only this OAuth client can see it, it isn't shown in Drive
 * and it uses no storage. No photos, names or file lists are kept, only byte counts and dates.
 *
 * Offload can't run on a schedule by itself (it holds no sign-ins between chats), so the daily check is a scheduled task
 * in the person's AI app that calls check_new_photos once a day. Growth is measured against a baseline that moves
 * forward once a day, so checking several times a day still adds up a day's uploads instead of comparing hour to hour.
 */

export const WATCH_NOTE = "offload-photos-watch";
export const DEFAULT_THRESHOLD_MB = 100;
const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A baseline older than this moves forward to today's figure, so slow growth (Gmail, a photo here and there) never adds up to an event. */
const BASELINE_MAX_AGE_MS = 20 * 60 * 60 * 1000;

export type EventStatus = "open" | "sent" | "skipped";

/** What one account's note holds. Times are ISO strings; sizes are bytes. */
export type WatchNote = {
  /** When watching started. */
  first: string;
  /** The figure growth is measured against, and when it was taken. */
  baseAt: string;
  base: number;
  /** The last check. */
  lastAt: string;
  last: number;
  /** The latest event: the window the new photos arrived in, how much arrived, and whether the person dealt with it. */
  ev?: { from: string; to: string; bytes: number; status: EventStatus; at: string };
};

export class WatchUnavailableError extends Error {
  constructor(readonly email: string) {
    super(
      `Offload couldn't keep its note in ${email}'s Drive, so it can't remember the storage between checks. ` +
        "Reconnect Offload once (in your AI app's connector settings) and allow it on Google's screen."
    );
  }
}

/** Google Photos + Gmail, and Drive, in bytes. */
export async function photosAndGmailBytes(acct: Account): Promise<{ other: number; drive: number; usage: number }> {
  const res = await drive(acct, "GET", "about", { fields: "storageQuota(usage,usageInDrive)" });
  const usage = Number(res.storageQuota?.usage || 0);
  const inDrive = Number(res.storageQuota?.usageInDrive || 0);
  return { other: Math.max(0, usage - inDrive), drive: inDrive, usage };
}

function noteFrom(p: Record<string, string> | undefined): WatchNote | null {
  if (!p || !p.first || !p.baseAt || p.base === undefined) return null;
  const n = (v: string | undefined) => Number(v || 0);
  const note: WatchNote = {
    first: p.first,
    baseAt: p.baseAt,
    base: n(p.base),
    lastAt: p.lastAt || p.baseAt,
    last: p.last !== undefined ? n(p.last) : n(p.base),
  };
  if (p.evFrom && p.evTo && p.evStatus) {
    const status = (["open", "sent", "skipped"] as const).find((s) => s === p.evStatus);
    if (status) note.ev = { from: p.evFrom, to: p.evTo, bytes: n(p.evBytes), status, at: p.evAt || p.evTo };
  }
  return note;
}

function noteProps(n: WatchNote): Record<string, string | null> {
  return {
    first: n.first,
    baseAt: n.baseAt,
    base: String(n.base),
    lastAt: n.lastAt,
    last: String(n.last),
    // null removes a key (Drive merges appProperties on update).
    evFrom: n.ev?.from ?? null,
    evTo: n.ev?.to ?? null,
    evBytes: n.ev ? String(n.ev.bytes) : null,
    evStatus: n.ev?.status ?? null,
    evAt: n.ev?.at ?? null,
  };
}

/** Drive refused the application data folder: the sign-in doesn't cover it. */
function scopeRefused(e: unknown): boolean {
  return (
    e instanceof DriveError &&
    (e.status === 403 || e.status === 401) &&
    !["rateLimitExceeded", "userRateLimitExceeded", "storageQuotaExceeded"].includes(e.reason)
  );
}

export async function readNote(acct: Account): Promise<{ id: string; note: WatchNote | null } | null> {
  try {
    const res = await drive(acct, "GET", "files", {
      spaces: "appDataFolder",
      q: `name = '${WATCH_NOTE}' and trashed = false`,
      fields: "files(id,appProperties)",
      pageSize: 1,
    });
    const f = res.files?.[0];
    return f ? { id: f.id, note: noteFrom(f.appProperties) } : null;
  } catch (e) {
    if (scopeRefused(e)) throw new WatchUnavailableError(acct.e);
    throw e;
  }
}

export async function writeNote(acct: Account, id: string | null, note: WatchNote): Promise<string> {
  const appProperties = noteProps(note);
  try {
    if (id) {
      await drive(acct, "PATCH", `files/${id}`, { fields: "id" }, { appProperties });
      return id;
    }
    const set = Object.fromEntries(Object.entries(appProperties).filter(([, v]) => v !== null));
    const res = await drive(acct, "POST", "files", { fields: "id" }, { name: WATCH_NOTE, parents: ["appDataFolder"], appProperties: set });
    return res.id;
  } catch (e) {
    if (scopeRefused(e)) throw new WatchUnavailableError(acct.e);
    throw e;
  }
}

/**
 * The pure part of a check: given the note (or none) and today's figure, works out the new note and what happened.
 * Kept free of Google calls so it can be tested on its own.
 */
export function step(prev: WatchNote | null, other: number, now: Date, thresholdBytes: number) {
  const at = now.toISOString();
  if (!prev) {
    return { note: { first: at, baseAt: at, base: other, lastAt: at, last: other } as WatchNote, started: true, grown: 0, since: at, fresh: false };
  }
  const grown = other - prev.base;
  const note: WatchNote = { ...prev, lastAt: at, last: other, ...(prev.ev ? { ev: { ...prev.ev } } : {}) };
  let fresh = false;
  if (grown >= thresholdBytes) {
    fresh = true;
    if (note.ev?.status === "open") {
      // Still undealt with: the new photos belong to the same stretch (a long trip), so the event grows.
      note.ev = { ...note.ev, to: at, bytes: note.ev.bytes + grown, at };
    } else {
      note.ev = { from: prev.baseAt, to: at, bytes: grown, status: "open", at };
    }
    note.baseAt = at;
    note.base = other;
  } else if (grown < 0 || now.getTime() - Date.parse(prev.baseAt) >= BASELINE_MAX_AGE_MS) {
    // Space was freed, or a day has passed without an event: start measuring from today.
    note.baseAt = at;
    note.base = other;
  }
  return { note, started: false, grown, since: prev.baseAt, fresh };
}

export type AccountCheck = {
  email: string;
  started: boolean;
  watching_since: string;
  last_checked: string | null;
  grown_since_baseline: string;
  baseline_taken: string;
  photos_and_gmail_now: string;
  event: null | {
    status: EventStatus;
    new_since_last_check: boolean;
    added: string;
    added_bytes: number;
    from: string;
    to: string;
    from_date: string;
    to_date: string;
    detected: string;
  };
};

const day = (iso: string) => iso.slice(0, 10);
const pretty = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export async function checkAccount(acct: Account, thresholdMb: number, now = new Date()): Promise<AccountCheck> {
  const [{ other }, found] = await Promise.all([photosAndGmailBytes(acct), readNote(acct)]);
  const prev = found?.note || null;
  const r = step(prev, other, now, thresholdMb * MB);
  await writeNote(acct, found?.id || null, r.note);
  const ev = r.note.ev;
  return {
    email: acct.e,
    started: r.started,
    watching_since: r.note.first,
    last_checked: prev ? prev.lastAt : null,
    grown_since_baseline: human(Math.max(0, r.grown)),
    baseline_taken: r.since,
    photos_and_gmail_now: human(other),
    event: ev
      ? {
          status: ev.status,
          new_since_last_check: r.fresh,
          added: human(ev.bytes),
          added_bytes: ev.bytes,
          from: ev.from,
          to: ev.to,
          from_date: day(ev.from),
          to_date: day(ev.to),
          detected: ev.at,
        }
      : null,
  };
}

/** Deletes an account's note: watching stops, and nothing about it is left in the account. */
export async function stopWatching(acct: Account): Promise<{ email: string; deleted: boolean }> {
  const found = await readNote(acct);
  if (!found) return { email: acct.e, deleted: false };
  try {
    await drive(acct, "DELETE", `files/${found.id}`);
  } catch (e) {
    if (scopeRefused(e)) throw new WatchUnavailableError(acct.e);
    throw e;
  }
  return { email: acct.e, deleted: true };
}

/** Marks an account's open event as dealt with: its photos were sent, or the person said no. */
export async function resolveEvent(acct: Account, status: "sent" | "skipped"): Promise<{ email: string; closed: boolean; added?: string }> {
  const found = await readNote(acct);
  const note = found?.note;
  if (!found || !note?.ev || note.ev.status !== "open") return { email: acct.e, closed: false };
  note.ev = { ...note.ev, status };
  await writeNote(acct, found.id, note);
  return { email: acct.e, closed: true, added: human(note.ev.bytes) };
}

/** One sentence about an open event, for the result's message. */
export function eventSentence(c: AccountCheck): string {
  const ev = c.event!;
  const span = ev.from_date === ev.to_date ? `on ${pretty(ev.to)}` : `between ${pretty(ev.from)} and ${pretty(ev.to)}`;
  return `About ${ev.added} of new photos and videos arrived in ${c.email}'s Google Photos ${span}, which looks like a new event.`;
}

/** What to choose in Google's picker for this event: the days the photos arrived in (plus the day before, for photos taken earlier and uploaded later). */
export function pickHint(c: AccountCheck): string {
  const ev = c.event!;
  const from = new Date(Date.parse(ev.from) - DAY_MS).toISOString();
  return `In the Google Photos picker, pick the photos from ${pretty(from)} to ${pretty(ev.to)} (the newest ones, at the top of Photos).`;
}

/** The prompt for the daily scheduled task in the person's AI app. */
export const DAILY_CHECK_PROMPT =
  "Use Offload's check_new_photos to see whether my Google Photos grew by 100 MB or more since yesterday. " +
  "If it found a new event, tell me how much was added and when, and ask whether I want to send that event's photos to the people in them " +
  "(a Google Drive folder per person, named after them and shared with them). Don't pick, copy or share anything until I say yes. " +
  "If nothing new arrived, say so in one line.";
