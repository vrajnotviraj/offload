import type { Account } from "@/lib/drive/api";
import { addToFolder, count, createFolder, folderIn, human, listing } from "@/lib/drive/engine";
import { addToAlbum, copyPickedServer, createAlbum, picked, requireLibrary, requirePicker, type CopyState, type Made, type PickToken, type Relays } from "./connector";

/**
 * Sorting picked Google Photos into groups (one album and/or Drive folder per group), in one job.
 *
 * Offload doesn't decide who or what is in a photo. In the connector, the AI looks at the previews (show_photos), agrees
 * the groups with the person, and passes them here as item numbers; in the web app the person tags each photo themselves
 * (components/app/PhotoTagger.tsx), and this runs in the browser with the site's relay (one group per person across the whole pick, matched by face, not outfit).
 * No face data is made or kept. This module only does the filing:
 * each photo is copied once, then put in every group it belongs to (more albums for the same copy, or shortcuts in
 * Drive), so a photo in five groups still uses its storage once.
 */

export const MAX_GROUPS = 50;

export type SortGroup = { name: string; items: number[] }; // items: 0-based positions in the picked set

/** One destination's progress. A copy job runs in steps; after each step its copies are filed into their groups. */
type Lane = {
  dest: "photos" | "drive";
  /** Google Photos: an album per group (same order as groups), plus the album holding every copy. */
  albums?: { id: string; link: string }[];
  all?: { id: string; link: string } | null;
  /** Drive: the parent folder and a folder per group. */
  parent?: { id: string; name: string; link: string };
  folders?: { id: string; link: string }[];
  copy: CopyState | null;
  done: boolean;
  /** Google Photos: [item, media item id] of each copy made, so later merges can file the same copy into more albums. */
  made?: [number, string][];
};

export type SortState = {
  k: "psort";
  a: number; // source account
  to: number; // receiving account
  id: string; // picking session
  title: string; // the "all" album / parent folder name
  parentId?: string; // Drive: folder to make the parent folder in (default My Drive)
  groups: SortGroup[];
  lanes: Lane[];
  lane: number;
  filed: number; // group placements made (album adds + folder moves/shortcuts)
  problems: { detail: string }[];
};

const link = (id: string) => `https://drive.google.com/drive/folders/${id}`;

/** Checks the groups against the pick and builds the job. Throws with a plain explanation if something doesn't fit. */
export async function startSort(
  accounts: Account[],
  t: PickToken,
  o: { to: number; dests: ("photos" | "drive")[]; groups: { name: string; items: number[] }[]; title?: string; parentId?: string }
): Promise<{ ready: false } | { ready: true; st: SortState }> {
  const from = accounts[t.a];
  const to = accounts[o.to];
  requirePicker(from);
  if (o.dests.includes("photos")) {
    if (o.to === t.a) throw new Error("Pick a different account for the albums: that's the one the photos are in. (Drive folders can be in the same account.)");
    requireLibrary(to);
  }
  const r = await picked(accounts, t);
  if (!r.ready) return { ready: false };
  const n = r.items.length;

  const seen = new Set<string>();
  const groups: SortGroup[] = [];
  for (const g of o.groups) {
    const name = g.name.replace(/\s+/g, " ").trim();
    if (!name) throw new Error("Every group needs a name.");
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Two groups are called "${name}". Give each group its own name.`);
    seen.add(key);
    const outside = g.items.filter((x) => x < 1 || x > n);
    if (outside.length) {
      throw new Error(
        `"${name}" lists ${listing(outside.map(String))}, but there ${n === 1 ? "is 1 picked item" : `are ${n} picked items`}. show_photos lists the item numbers.`
      );
    }
    const items = [...new Set(g.items)].sort((x, y) => x - y).map((x) => x - 1);
    if (!items.length) throw new Error(`"${name}" has no photos in it.`);
    groups.push({ name, items });
  }
  if (!groups.length) throw new Error("Pass at least one group.");

  const title = (o.title || `Sorted from ${from.e}`).replace(/\s+/g, " ").trim();
  if (o.parentId && o.dests.includes("drive")) await folderIn(to, o.parentId); // fail now, not halfway
  return {
    ready: true,
    st: {
      k: "psort",
      a: t.a,
      to: o.to,
      id: t.id,
      title,
      ...(o.parentId ? { parentId: o.parentId } : {}),
      groups,
      lanes: o.dests.map((dest) => ({ dest, copy: null, done: false })),
      lane: 0,
      filed: 0,
      problems: [],
    },
  };
}

/** Every picked item that's in at least one group, in order. */
const union = (st: SortState) => [...new Set(st.groups.flatMap((g) => g.items))].sort((x, y) => x - y);

/** Makes the albums or folders for a lane, once. */
async function setUp(st: SortState, lane: Lane, to: Account) {
  if (lane.dest === "photos" && !lane.albums) {
    const albums: { id: string; link: string }[] = [];
    for (const g of st.groups) {
      const a = await createAlbum(to, g.name);
      albums.push({ id: a.album_id, link: a.link });
    }
    lane.albums = albums;
  }
  if (lane.dest === "drive" && !lane.parent) {
    const p = await createFolder(to, st.title, st.parentId);
    lane.parent = { id: p.folder_id, name: p.name, link: p.link };
    const folders: { id: string; link: string }[] = [];
    for (const g of st.groups) {
      const f = await createFolder(to, g.name, p.folder_id);
      folders.push({ id: f.folder_id, link: f.link });
    }
    lane.folders = folders;
  }
  if (!lane.copy) {
    lane.copy = {
      k: "pcopy",
      a: st.a,
      to: st.to,
      id: st.id,
      dest: lane.dest,
      pick: union(st),
      next: 0,
      open: [],
      album: null,
      ...(lane.dest === "photos" ? { albumTitle: st.title } : {}),
      folder: lane.dest === "drive" ? lane.parent! : null,
      total: 0,
      copied: 0,
      failed: 0,
      bytes: 0,
      errors: [],
    };
  }
}

/** Files one step's copies into their groups: more albums for the same copy, or a move plus shortcuts in Drive. */
async function file(st: SortState, lane: Lane, to: Account, made: Made[]) {
  const byItem = new Map(made.map((m) => [m.item - 1, m.id]));
  const note = (detail: string) => {
    if (st.problems.length < 20) st.problems.push({ detail });
  };
  if (lane.dest === "photos") {
    for (const [gi, g] of st.groups.entries()) {
      const ids = g.items.map((i) => byItem.get(i)).filter((x): x is string => !!x);
      if (!ids.length) continue;
      const r = await addToAlbum(to, lane.albums![gi].id, ids);
      st.filed += r.added;
      if (r.not_added?.length) note(`${count(r.not_added.length, "photo")} couldn't be added to the album "${g.name}".`);
    }
    return;
  }
  // Drive keeps each file in one folder: it goes in its first group's folder, with shortcuts in the others.
  const moves = new Map<number, string[]>();
  const shortcuts = new Map<number, string[]>();
  for (const [i, id] of byItem) {
    const homes = st.groups.flatMap((g, gi) => (g.items.includes(i) ? [gi] : []));
    homes.forEach((gi, n) => {
      const m = n === 0 ? moves : shortcuts;
      m.set(gi, [...(m.get(gi) || []), id]);
    });
  }
  for (const [how, plan] of [["move", moves], ["shortcut", shortcuts]] as const) {
    for (const [gi, ids] of plan) {
      for (let k = 0; k < ids.length; k += 200) {
        const r = await addToFolder(to, ids.slice(k, k + 200), lane.folders![gi].id, how);
        const ok = (how === "move" ? (r as any).moved : (r as any).shortcuts) as unknown[] | undefined;
        st.filed += ok?.length || 0;
        if (r.problems?.length) note(`${count(r.problems.length, "file")} couldn't be put in the folder "${st.groups[gi].name}".`);
      }
    }
  }
}

/** Runs the job for up to `budgetMs`: set up, copy a step, file what was copied, then the next destination. */
export async function runSort(
  accounts: Account[],
  st: SortState,
  budgetMs: number,
  token: (a: Account, scope: string, force?: boolean) => Promise<string>,
  relays?: Relays
) {
  const to = accounts[st.to];
  if (!accounts[st.a] || !to) throw new Error("That job belongs to a different connection. Start again with pick_google_photos.");
  const start = Date.now();
  // Leave time after copying to file the copies into their groups.
  const copyBudget = Math.max(5_000, budgetMs * 0.7);
  while (st.lane < st.lanes.length) {
    const lane = st.lanes[st.lane];
    await setUp(st, lane, to);
    const left = copyBudget - (Date.now() - start);
    if (left <= 0) break;
    const { done, made } = await copyPickedServer(accounts, lane.copy!, left, token, relays);
    if (lane.dest === "photos" && lane.copy!.album) lane.all = { id: lane.copy!.album.id, link: lane.copy!.album.url };
    if (made.length) {
      if (lane.dest === "photos") lane.made = [...(lane.made || []), ...made.map((m): [number, string] => [m.item, m.id])];
      await file(st, lane, to, made);
    }
    if (!done) break;
    lane.done = true;
    st.lane++;
  }
  return st.lane >= st.lanes.length;
}

export function sortResult(st: SortState, accounts: Account[], done: boolean) {
  const from = accounts[st.a].e;
  const to = accounts[st.to].e;
  const total = union(st).length;
  const lanes = st.lanes.map((l) => {
    const c = l.copy;
    return {
      into: l.dest === "photos" ? "google_photos" : "google_drive",
      done: l.done,
      copied: c?.copied || 0,
      failed: c?.failed || 0,
      size: human(c?.bytes || 0),
      ...(l.dest === "photos" && l.all?.link ? { all_photos_album: l.all.link } : {}),
      ...(l.dest === "drive" && l.parent ? { parent_folder: l.parent.link } : {}),
      groups: st.groups.map((g, gi) => ({
        name: g.name,
        photos: g.items.length,
        items: g.items.map((i) => i + 1),
        ...(l.dest === "photos" && l.albums ? { album_id: l.albums[gi].id, album: l.albums[gi].link } : {}),
        ...(l.dest === "drive" && l.folders ? { folder_id: l.folders[gi].id, folder: l.folders[gi].link || link(l.folders[gi].id) } : {}),
      })),
      ...(l.dest === "photos" && done && l.made?.length ? { copies: l.made.map(([item, id]) => ({ item, id })) } : {}),
      ...(c?.errors.length ? { copy_problems: c.errors } : {}),
    };
  });
  const where = listing(st.lanes.map((l) => (l.dest === "photos" ? `albums in ${to}'s Google Photos` : `folders in ${to}'s Google Drive (in "${st.title}")`)));
  const copied = st.lanes.reduce((n, l) => n + (l.copy?.copied || 0), 0);
  const failed = st.lanes.reduce((n, l) => n + (l.copy?.failed || 0), 0);
  const message = done
    ? `Sorted ${count(total, "photo or video", "photos and videos")} from ${from} into ${count(st.groups.length, "group")}, as ${where}: ` +
      st.groups.map((g) => `${g.name} (${g.items.length})`).join(", ") +
      ". Each photo was copied once; one in several groups uses its storage once." +
      (failed ? ` ${count(failed, "item")} couldn't be copied.` : "") +
      (st.problems.length ? " Some couldn't be filed: see problems." : "") +
      ` The originals are still in ${from}'s Google Photos.`
    : `Still sorting into ${to}: ${copied.toLocaleString("en-US")} copies made so far. Carrying on…`;
  return {
    message,
    done,
    from,
    to,
    photos: total,
    groups: st.groups.length,
    placements: st.filed,
    results: lanes,
    ...(st.problems.length ? { problems: st.problems } : {}),
  };
}
