/**
 * Files people's photos into Google Drive folders: one parent folder, and inside it one folder per person.
 *
 * - Into the account the photos are in: each person's folder gets shortcuts to their photos. Nothing is copied or moved,
 *   so it uses no storage, and a photo with three people in it shows up in all three folders.
 * - Into another linked account: each photo is copied there once (into its first person's folder), and the other folders
 *   get shortcuts to that copy. The copy uses the receiving account's storage; the original stays where it is. To copy,
 *   the photo is shared with the receiving account for a moment (quietly, no email) and the share is removed afterwards,
 *   unless that account could already see it.
 */

import { drive, type Account } from "@/lib/drive/api";
import { addToFolder, createFolder } from "@/lib/drive/engine";

export type PersonGroup = { name: string; photoIds: string[] };

export type FileProgress = { step: string; done: number; total: number };

export type FileResult = {
  parent: { id: string; link: string; name: string };
  folders: { name: string; id: string; link: string; photos: number }[];
  copied: number;
  shortcuts: number;
  problems: string[];
};

const PARALLEL = 4;

async function pool<T>(items: T[], fn: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, q.length) }, async () => {
      for (let x = q.shift(); x !== undefined; x = q.shift()) await fn(x);
    })
  );
}

/** Copies one of `from`'s Drive files into `to`'s folder `parentId`. Returns the copy's ID. */
async function copyAcross(from: Account, to: Account, fileId: string, parentId: string): Promise<string> {
  const f = await drive<{ name: string; permissions?: { id: string; emailAddress?: string }[] }>(from, "GET", `files/${fileId}`, {
    fields: "name,permissions(id,emailAddress)",
    supportsAllDrives: true,
  });
  const already = (f.permissions || []).some((p) => p.emailAddress?.toLowerCase() === to.e);
  let permId: string | null = null;
  if (!already) {
    const p = await drive<{ id: string }>(
      from,
      "POST",
      `files/${fileId}/permissions`,
      { sendNotificationEmail: false, fields: "id", supportsAllDrives: true },
      { type: "user", role: "reader", emailAddress: to.e }
    );
    permId = p.id;
  }
  try {
    const copy = await drive<{ id: string }>(to, "POST", `files/${fileId}/copy`, { fields: "id", supportsAllDrives: true }, { name: f.name, parents: [parentId] });
    return copy.id;
  } finally {
    if (permId) await drive(from, "DELETE", `files/${fileId}/permissions/${permId}`, { supportsAllDrives: true }).catch(() => {});
  }
}

export async function fileIntoPeople(
  from: Account,
  to: Account,
  parentName: string,
  groups: PersonGroup[],
  onProgress: (p: FileProgress) => void
): Promise<FileResult> {
  const problems: string[] = [];
  onProgress({ step: "Making folders", done: 0, total: groups.length + 1 });
  const parent = await createFolder(to, parentName);
  const folders: FileResult["folders"] = [];
  for (const [i, g] of groups.entries()) {
    const f = await createFolder(to, g.name, parent.folder_id);
    folders.push({ name: f.name, id: f.folder_id, link: f.link, photos: g.photoIds.length });
    onProgress({ step: "Making folders", done: i + 2, total: groups.length + 1 });
  }

  // Which folders each photo goes in, in group order.
  const homes = new Map<string, number[]>();
  groups.forEach((g, gi) => g.photoIds.forEach((id) => homes.set(id, [...(homes.get(id) || []), gi])));
  const photos = [...homes.keys()];
  let copied = 0;
  let shortcuts = 0;
  let done = 0;
  const step = from.e === to.e ? "Adding shortcuts" : `Copying photos to ${to.e}`;
  onProgress({ step, done, total: photos.length });

  await pool(photos, async (id) => {
    const into = homes.get(id)!;
    try {
      let target = id;
      let rest = into;
      if (from.e !== to.e) {
        target = await copyAcross(from, to, id, folders[into[0]].id);
        copied++;
        rest = into.slice(1);
      }
      for (const gi of rest) {
        const r = await addToFolder(to, [target], folders[gi].id, "shortcut");
        shortcuts += (r as { shortcuts?: unknown[] }).shortcuts?.length || 0;
        for (const p of (r as { problems?: { detail: string }[] }).problems || []) problems.push(p.detail);
      }
    } catch (e) {
      problems.push(e instanceof Error ? e.message : String(e));
    }
    onProgress({ step, done: ++done, total: photos.length });
  });

  return { parent: { id: parent.folder_id, link: parent.link, name: parent.name }, folders, copied, shortcuts, problems };
}
