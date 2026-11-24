import { gmail, type Account } from "@/lib/drive/api";
import { count } from "@/lib/drive/engine";

/**
 * Gmail cleanup for the Offload web app.
 *
 * Quick filters plus free-text fields build one Gmail search, which is counted and previewed. Trashing works on
 * emails (not whole conversations), so a starred or important reply in a matching thread is never swept up with it.
 * It is built for speed: the search is paged 500 emails at a time while earlier pages are already being moved,
 * 1,000 emails per call (messages.batchModify adding the TRASH label, which is exactly what "Move to Trash" does).
 * Moving mail while paging can shift later pages, so once the first pass ends the search runs again from the top
 * until nothing new turns up. It never moves more than the person confirmed. Nothing is deleted for good: Gmail
 * empties its Trash after 30 days, or the person does. Only the headers (subject, sender, date) of the newest few
 * matches are ever read, to show what a search found.
 */

export const GMAIL_FILTERS = {
  promotions: { label: "Promotions", q: "category:promotions" },
  social: { label: "Social", q: "category:social" },
  updates: { label: "Updates", q: "category:updates" },
  large: { label: "Bigger than 10 MB", q: "larger:10M" },
  attachment: { label: "Has attachments", q: "has:attachment" },
  old: { label: "Older than a year", q: "older_than:1y" },
} as const;
export type GmailFilter = keyof typeof GMAIL_FILTERS;

export type GmailSearch = { filters: GmailFilter[]; words?: string; subject?: string; from?: string; keepStarred?: boolean };

/** messages.list returns at most 500 ids a page. */
const PAGE = 500;
/** messages.batchModify takes at most 1,000 ids a call. */
const BATCH = 1000;
/** batchModify calls in flight at once: 2 × 50 quota units stays well under Gmail's 250 units a second per person. */
const IN_FLIGHT = 2;
const COUNT_CAP = 25_000;
const PREVIEW = 20;
/** Re-searches after the first pass, to pick up anything a shifting page skipped. */
const MAX_SWEEPS = 8;

/** The Gmail search for these choices. Throws if nothing was chosen. */
export function gmailQuery(f: GmailSearch): string {
  const parts: string[] = [];
  for (const k of f.filters || []) if (GMAIL_FILTERS[k]) parts.push(GMAIL_FILTERS[k].q);
  const from = String(f.from || "").replace(/[()"]/g, " ").trim();
  if (from) parts.push(`from:(${from})`);
  const subject = String(f.subject || "").replace(/"/g, " ").trim();
  if (subject) parts.push(`subject:("${subject}")`);
  const words = String(f.words || "").trim();
  if (words) parts.push(words);
  if (!parts.length) throw new Error("Pick a quick filter or type something to search for.");
  if (f.keepStarred !== false) parts.push("-is:starred -is:important");
  return parts.join(" ");
}

/** Opens the same search in Gmail, signed in as `email`. */
export function gmailSearchUrl(email: string, query: string) {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#search/${encodeURIComponent(query)}`;
}

export function gmailTrashUrl(email: string) {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#trash`;
}

export type GmailItem = { id: string; subject: string; from: string; date: string };

function listPage(acct: Account, q: string, pageToken?: string): Promise<{ ids: string[]; next?: string }> {
  return gmail(acct, "GET", "messages", { q, maxResults: PAGE, pageToken, fields: "messages(id),nextPageToken" }).then((r: any) => ({
    ids: (r.messages || []).map((m: any) => String(m.id)),
    next: r.nextPageToken || undefined,
  }));
}

function header(msg: any, name: string): string {
  const h = (msg?.payload?.headers || []).find((x: any) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : "";
}

/** "Shop Deals <deals@shop.com>" → "Shop Deals" */
function senderName(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from);
  return (m ? m[1] : from).trim();
}

/** Subject, sender and date of these emails, all fetched at once. */
async function loadItems(acct: Account, ids: string[]): Promise<GmailItem[]> {
  return Promise.all(
    ids.map(async (id) => {
      try {
        const m = await gmail(acct, "GET", `messages/${id}`, {
          format: "metadata",
          metadataHeaders: ["Subject", "From"],
          fields: "id,internalDate,payload/headers",
        });
        return {
          id,
          subject: header(m, "Subject") || "(no subject)",
          from: senderName(header(m, "From")),
          date: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : "",
        };
      } catch {
        return { id, subject: "(couldn't load this one)", from: "", date: "" };
      }
    })
  );
}

export type GmailPreview = {
  query: string;
  count: number;
  /** Stopped counting at the cap or the time budget: there are more than `count`. */
  capped: boolean;
  /** Still paging through the matches; `count` is a running total. */
  counting: boolean;
  /** The newest matches, or null while they load. */
  items: GmailItem[] | null;
  message: string;
};

/**
 * Counts matching emails (up to 25,000) and fetches the newest 20 to show. The newest ones load alongside the count,
 * and `onUpdate` gets the running result after every page so the number climbs live. Stops early once `alive()` is
 * false (the person changed the search).
 */
export async function gmailPreview(
  acct: Account,
  f: GmailSearch,
  opts: { onUpdate?: (p: GmailPreview) => void; alive?: () => boolean; budgetMs?: number } = {}
): Promise<GmailPreview> {
  const query = gmailQuery(f);
  const alive = opts.alive || (() => true);
  const budget = opts.budgetMs ?? 12_000;
  const start = Date.now();

  const first = await listPage(acct, query);
  let total = first.ids.length;
  let next = first.next;
  let capped = false;
  let counting = !!next;
  let items: GmailItem[] | null = first.ids.length ? null : [];

  const snap = (): GmailPreview => {
    const n = capped || counting ? `${total.toLocaleString("en-US")}+ emails` : count(total, "email");
    return {
      query,
      count: total,
      capped,
      counting,
      items,
      message: total ? `${n} match in ${acct.e}.` : `No emails match in ${acct.e}.`,
    };
  };
  const emit = () => alive() && opts.onUpdate?.(snap());

  const shown = loadItems(acct, first.ids.slice(0, PREVIEW)).then((it) => {
    items = it;
    emit();
  });
  emit();

  while (next && alive()) {
    if (total >= COUNT_CAP || Date.now() - start > budget) {
      capped = true;
      break;
    }
    const page = await listPage(acct, query, next);
    total += page.ids.length;
    next = page.next;
    emit();
  }
  counting = false;
  await shown;
  return snap();
}

export type TrashProgress = {
  query: string;
  /** How many the person confirmed; 0 = everything that matches. */
  limit: number;
  /** Best idea so far of how many will move: the preview's count, raised as the search turns up more. */
  total: number;
  /** `total` is exact: the search has been paged to the end. */
  totalSure: boolean;
  trashed: number;
  failed: number;
  started: number;
  /** When it finished (0 while running). */
  ended: number;
  done: boolean;
  message: string;
};

/**
 * Moves every email matching the search (up to `limit`, 0 = all) to Trash, as fast as Gmail allows, reporting
 * progress after every page listed and every batch moved. `expected` is the preview's count, for the progress bar.
 */
export async function trashMatching(
  acct: Account,
  f: GmailSearch,
  opts: { limit: number; expected: number; onProgress?: (p: TrashProgress) => void }
): Promise<TrashProgress> {
  const limit = Math.max(0, Math.floor(opts.limit) || 0);
  const cap = limit || Infinity;
  const p: TrashProgress = {
    query: gmailQuery(f),
    limit,
    total: limit || Math.max(0, opts.expected || 0),
    totalSure: !!limit,
    trashed: 0,
    failed: 0,
    started: Date.now(),
    ended: 0,
    done: false,
    message: "",
  };

  const say = () => {
    const failed = p.failed ? ` ${count(p.failed, "email")} couldn't be moved.` : "";
    p.message = p.done
      ? (p.trashed
          ? `Moved ${count(p.trashed, "email")} to Trash in ${acct.e}.`
          : `Nothing left to move: no emails match in ${acct.e}.`) +
        failed +
        (p.trashed ? " They stay in Trash for 30 days, then Gmail deletes them; the space frees up then, or straight away if you empty the Trash." : "")
      : `Moving to Trash in ${acct.e}…`;
  };
  const report = () => {
    say();
    opts.onProgress?.({ ...p });
  };

  const seen = new Set<string>();
  const queue: string[] = [];
  const inflight = new Set<Promise<void>>();
  let lastError: unknown = null;

  const send = (ids: string[]) => {
    const t: Promise<void> = gmail(acct, "POST", "messages/batchModify", undefined, { ids, addLabelIds: ["TRASH"] })
      .then(() => {
        p.trashed += ids.length;
      })
      .catch((e) => {
        p.failed += ids.length;
        lastError = e;
      })
      .finally(() => {
        inflight.delete(t);
        report();
      });
    inflight.add(t);
  };

  /** Sends full batches (or everything, with `all`), keeping at most IN_FLIGHT calls going. */
  const drain = async (all: boolean) => {
    while (queue.length >= BATCH || (all && queue.length)) {
      send(queue.splice(0, BATCH));
      if (inflight.size >= IN_FLIGHT) await Promise.race(inflight);
    }
    if (all) await Promise.all(inflight);
  };

  report();
  for (let sweep = 0; sweep <= MAX_SWEEPS && seen.size < cap; sweep++) {
    const before = seen.size;
    let next: string | undefined;
    do {
      const page = await listPage(acct, p.query, next);
      for (const id of page.ids) {
        if (seen.size >= cap) break;
        if (seen.has(id)) continue;
        seen.add(id);
        queue.push(id);
      }
      next = page.next;
      if (!p.totalSure) p.total = Math.max(p.total, seen.size);
      if (sweep === 0 && !next) {
        // The first pass reached the end of the search: now the total is known.
        p.total = Math.min(cap, seen.size);
        p.totalSure = true;
      }
      report();
      await drain(false);
      // A whole batch failing for a reason that won't go away (no permission, say): stop instead of pressing on.
      if (lastError && !p.trashed) break;
    } while (next && seen.size < cap);
    await drain(true);
    if (lastError && !p.trashed) break;
    if (seen.size === before) break; // the search came back with nothing new: all done
  }

  if (lastError && !p.trashed) throw lastError;
  p.total = p.trashed + p.failed;
  p.totalSure = true;
  p.done = true;
  p.ended = Date.now();
  report();
  return { ...p };
}
