/**
 * Sorting picked Google Photos in the web app: the person tags each photo with who's in it (PhotoTagger), and this runs
 * the same sorting job the AI connector uses (lib/photos/sort.ts), in the browser, with the bytes going through this
 * site's relay (/api/photos/copy). Offload never decides who is in a photo: the groups are the person's own tags.
 */

import { PICKER_SCOPE, type Account } from "@/lib/drive/api";
import { tokenFor } from "@/lib/drive/browserAuth";
import type { Relays } from "./connector";
import { relayViaSite } from "./engine";
import type { DriveRelayRequest, DriveRelayResponse } from "./relay";
import { runSort, sortResult, startSort, type SortState } from "./sort";

/** Browser accounts carry no permission flags (the browser asks Google per scope instead); the sort engine checks them. */
const withPhotos = (a: Account): Account => ({ ...a, ph: "pa" });

const relays: Relays = {
  photos: relayViaSite,
  drive: async (r: DriveRelayRequest): Promise<DriveRelayResponse> => {
    const res = await fetch("/api/photos/copy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...r, to: "drive" }) });
    try {
      return (await res.json()) as DriveRelayResponse;
    } catch {
      return { ok: false, status: res.status, side: "request", error: `The copy service didn't answer (HTTP ${res.status}).` };
    }
  },
};

export type TagSortProgress = { done: number; total: number; message: string };
export type TagSortResult = ReturnType<typeof sortResult>;

/**
 * Sorts the picked items into one album and/or Drive folder per person, in `to`. `groups` are names with item numbers
 * (1-based positions in the pick). Runs to the end, reporting progress after each step.
 */
export async function sortTagged(
  from: Account,
  to: Account,
  sessionId: string,
  groups: { name: string; items: number[] }[],
  o: { dests: ("photos" | "drive")[]; title: string },
  onProgress: (p: TagSortProgress) => void
): Promise<TagSortResult> {
  const accounts = from.e === to.e ? [withPhotos(from)] : [withPhotos(from), withPhotos(to)];
  const toIdx = from.e === to.e ? 0 : 1;
  const s = await startSort(accounts, { k: "pick", a: 0, id: sessionId }, { to: toIdx, dests: o.dests, groups, title: o.title });
  if (!s.ready) throw new Error("Google says the picking isn't finished. Pick again and press Done in Google's window.");
  const st: SortState = s.st;
  const perLane = new Set(st.groups.flatMap((g) => g.items)).size;
  const total = perLane * st.lanes.length;
  const tick = () => {
    const done = st.lanes.reduce((n, l) => n + (l.copy ? l.copy.copied + l.copy.failed : 0), 0);
    onProgress({ done: Math.min(done, total), total, message: sortResult(st, accounts, false).message });
  };
  tick();
  for (;;) {
    const finished = await runSort(accounts, st, 20_000, tokenFor, relays);
    tick();
    if (finished) return sortResult(st, accounts, true);
  }
}

/* ------------------------------ Previews ------------------------------ */

let direct: boolean | null = null; // can this browser load previews from Google directly? Learnt from the first one.

/** A small preview of a picked item, as an object URL. Tries Google directly; falls back to this site's preview route. */
export async function pickedThumb(from: Account, baseUrl: string, px = 256): Promise<string> {
  const token = await tokenFor(from, PICKER_SCOPE);
  if (direct !== false) {
    try {
      const res = await fetch(`${baseUrl}=w${px}-h${px}-c`, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) {
        direct = true;
        return URL.createObjectURL(await res.blob());
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    } catch (e) {
      if ((e as { status?: number }).status) throw e; // Google answered: the link or sign-in is the problem, not the browser
      direct = false; // blocked (CORS): use the site from now on
    }
  }
  const res = await fetch("/api/photos/thumb", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ src: baseUrl, token, px }) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return URL.createObjectURL(await res.blob());
}
