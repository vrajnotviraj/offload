import { drive, DriveError, type Account } from "@/lib/drive/api";
import { count, FOLDER_MIME, folderIn, listing } from "@/lib/drive/engine";

/**
 * Sharing a Drive folder (for example one sort_photos made per person) with people the person chose, or with anyone
 * who has the link.
 *
 * The catch: a photo in several groups lives in its first group's folder and is a shortcut in the others. A shortcut
 * only opens if the person it's shared with can see the file it points to, so after sharing the folder this also gives
 * the same access to every file its shortcuts point to outside the folder (no notification for those, no extra
 * storage). That part runs in steps with a continue_token, since a big folder can have hundreds.
 */

const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
export const MAX_SHARE_EMAILS = 20;
const MAX_SCAN = 10_000; // items looked through in the folder, to find shortcuts
const PARALLEL = 6;

export type Access = "view" | "comment";
const ROLE: Record<Access, "reader" | "commenter"> = { view: "reader", comment: "commenter" };
const VERB: Record<Access, string> = { view: "view", comment: "view and comment on" };

export type ShareState = {
  k: "dshare";
  a: number; // account whose Drive the folder is in
  folder: { id: string; name: string; link: string };
  emails: string[];
  anyone: boolean;
  access: Access;
  notify: boolean;
  note?: string; // message for Google's notification email
  folderDone: boolean;
  people: { email: string; ok: boolean; detail?: string }[];
  linkOk?: boolean;
  next: number; // position in the sorted list of files the shortcuts point to
  targets: number;
  targetsShared: number;
  targetsFailed: number;
  scanCapped?: boolean;
  problems: { detail: string }[];
};

const reason = (e: unknown) => {
  if (e instanceof DriveError) {
    if (/notification/i.test(e.message) && /google account/i.test(e.message)) {
      return "That address has no Google account, so Google can only share by emailing an invitation: share again with notify on.";
    }
    if (e.reason === "invalidSharingRequest" || e.reason === "shareInNotPermitted" || e.reason === "shareOutNotPermitted") {
      return `Google refused the share: ${e.message}`;
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
};

/** Checks the request and builds the job. */
export async function startShare(
  accounts: Account[],
  a: number,
  o: { folderId: string; emails: string[]; anyone: boolean; access: Access; notify: boolean; note?: string }
): Promise<ShareState> {
  const acct = accounts[a];
  const emails = [...new Set(o.emails.map((x) => x.trim().toLowerCase()).filter(Boolean))];
  const bad = emails.filter((x) => !EMAIL_RE.test(x));
  if (bad.length) throw new Error(`${listing(bad)} ${bad.length === 1 ? "isn't an email address" : "aren't email addresses"}. find_contacts looks people up by name.`);
  if (!emails.length && !o.anyone) throw new Error("Pass emails (who to share with) or anyone_with_link: true.");
  if (emails.length > MAX_SHARE_EMAILS) throw new Error(`Share with at most ${MAX_SHARE_EMAILS} people at a time.`);
  const own = emails.filter((x) => x === acct.e);
  if (own.length) throw new Error(`${acct.e} is the account the folder is in: it already has it.`);

  if (!o.folderId || o.folderId === "root") throw new Error("Pick a folder to share, not the whole of My Drive.");
  const f = await folderIn(acct, o.folderId);
  const caps = await drive<{ capabilities?: { canShare?: boolean } }>(acct, "GET", `files/${f.id}`, { fields: "capabilities(canShare)", supportsAllDrives: true });
  if (caps.capabilities?.canShare === false) throw new Error(`${acct.e} isn't allowed to share "${f.name}". Only its owner, or someone it's shared with as an editor, can.`);

  return {
    k: "dshare",
    a,
    folder: { id: f.id, name: f.name, link: `https://drive.google.com/drive/folders/${f.id}` },
    emails,
    anyone: o.anyone,
    access: o.access,
    notify: o.notify,
    ...(o.note?.trim() ? { note: o.note.trim().slice(0, 1000) } : {}),
    folderDone: false,
    people: [],
    next: 0,
    targets: 0,
    targetsShared: 0,
    targetsFailed: 0,
    problems: [],
  };
}

/** Gives `id` the job's access: to each person (and/or anyone with the link). */
async function grant(acct: Account, st: ShareState, id: string, emails: string[], o: { notify: boolean; withNote: boolean }) {
  const role = ROLE[st.access];
  const out: { email?: string; ok: boolean; detail?: string }[] = [];
  for (const email of emails) {
    try {
      await drive(
        acct,
        "POST",
        `files/${id}/permissions`,
        {
          sendNotificationEmail: o.notify,
          ...(o.notify && o.withNote && st.note ? { emailMessage: st.note } : {}),
          supportsAllDrives: true,
          fields: "id",
        },
        { type: "user", role, emailAddress: email }
      );
      out.push({ email, ok: true });
    } catch (e) {
      out.push({ email, ok: false, detail: reason(e) });
    }
  }
  if (st.anyone) {
    try {
      await drive(acct, "POST", `files/${id}/permissions`, { supportsAllDrives: true, fields: "id" }, { type: "anyone", role, allowFileDiscovery: false });
      out.push({ ok: true });
    } catch (e) {
      out.push({ ok: false, detail: reason(e) });
    }
  }
  return out;
}

/** Every file the folder's shortcuts point to that isn't itself inside the folder, sorted so steps carry on in order. */
async function outsideTargets(acct: Account, st: ShareState): Promise<string[]> {
  const inside = new Set<string>([st.folder.id]);
  const targets = new Set<string>();
  const queue = [st.folder.id];
  let seen = 0;
  while (queue.length && seen < MAX_SCAN) {
    const parent = queue.shift()!;
    let pageToken: string | undefined;
    do {
      const r = await drive<{ nextPageToken?: string; files?: { id: string; mimeType: string; shortcutDetails?: { targetId?: string } }[] }>(
        acct,
        "GET",
        "files",
        {
          q: `'${parent}' in parents and trashed = false`,
          fields: "nextPageToken,files(id,mimeType,shortcutDetails(targetId))",
          pageSize: 1000,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        }
      );
      for (const f of r.files || []) {
        seen++;
        inside.add(f.id);
        if (f.mimeType === FOLDER_MIME) queue.push(f.id);
        else if (f.mimeType === SHORTCUT_MIME && f.shortcutDetails?.targetId) targets.add(f.shortcutDetails.targetId);
      }
      pageToken = r.nextPageToken;
    } while (pageToken && seen < MAX_SCAN);
  }
  if (seen >= MAX_SCAN) st.scanCapped = true;
  return [...targets].filter((id) => !inside.has(id)).sort();
}

/** Runs the job for up to `budgetMs`: share the folder once, then the files its shortcuts point to. Returns whether it's done. */
export async function runShare(accounts: Account[], st: ShareState, budgetMs: number) {
  const acct = accounts[st.a];
  if (!acct) throw new Error("That job belongs to a different connection. Start again without continue_token.");
  const start = Date.now();
  const note = (detail: string) => {
    if (st.problems.length < 20) st.problems.push({ detail });
  };

  if (!st.folderDone) {
    const r = await grant(acct, st, st.folder.id, st.emails, { notify: st.notify, withNote: true });
    st.people = r.filter((x) => x.email).map((x) => ({ email: x.email!, ok: x.ok, ...(x.detail ? { detail: x.detail } : {}) }));
    if (st.anyone) {
      const l = r.find((x) => !x.email)!;
      st.linkOk = l.ok;
      if (!l.ok) note(`Couldn't turn on link sharing: ${l.detail}`);
    }
    st.folderDone = true;
  }

  // Only people who got the folder get the files behind its shortcuts.
  const emails = st.people.filter((p) => p.ok).map((p) => p.email);
  const linkOn = st.anyone && st.linkOk;
  if (!emails.length && !linkOn) return true;

  const targets = await outsideTargets(acct, st);
  st.targets = targets.length;
  const job: ShareState = { ...st, anyone: !!linkOn };
  while (st.next < targets.length && Date.now() - start < budgetMs) {
    const batch = targets.slice(st.next, st.next + PARALLEL);
    const results = await Promise.all(batch.map((id) => grant(acct, job, id, emails, { notify: false, withNote: false })));
    results.forEach((r, i) => {
      const bad = r.filter((x) => !x.ok);
      if (bad.length) {
        st.targetsFailed++;
        note(`A file a shortcut points to (${batch[i]}) couldn't be shared: ${bad[0].detail}`);
      } else st.targetsShared++;
    });
    st.next += batch.length;
  }
  return st.next >= targets.length;
}

export function shareResult(st: ShareState, accounts: Account[], done: boolean) {
  const from = accounts[st.a].e;
  const ok = st.people.filter((p) => p.ok).map((p) => p.email);
  const failed = st.people.filter((p) => !p.ok);
  const parts: string[] = [];
  if (ok.length) {
    parts.push(
      `Shared the folder "${st.folder.name}" in ${from}'s Drive with ${listing(ok)}: they can ${VERB[st.access]} it` +
        (st.notify ? ", and Google emailed them a link." : ". Google didn't email them, so send them the link.")
    );
  }
  for (const p of failed) parts.push(`Couldn't share with ${p.email}: ${p.detail}`);
  if (st.anyone) {
    parts.push(st.linkOk ? `Anyone with the link can ${VERB[st.access]} "${st.folder.name}": ${st.folder.link}` : "Link sharing couldn't be turned on.");
  }
  if (st.targets) {
    parts.push(
      done
        ? `${count(st.targetsShared, "photo or file")} in other folders, which this folder's shortcuts point to, ${st.targetsShared === 1 ? "was" : "were"} shared too, so the shortcuts open.` +
            (st.targetsFailed ? ` ${count(st.targetsFailed, "one")} couldn't be: see problems.` : "")
        : `Still sharing the files this folder's shortcuts point to: ${st.next.toLocaleString("en-US")} of ${st.targets.toLocaleString("en-US")}. Carrying on…`
    );
  }
  if (st.scanCapped) parts.push(`The folder is very big: only its first ${MAX_SCAN.toLocaleString("en-US")} items were checked for shortcuts.`);
  if (done && (ok.length || st.linkOk)) parts.push(`To stop sharing, use Share on the folder in Drive.`);
  return {
    message: parts.join(" ") || "Nothing was shared.",
    done,
    account: from,
    folder: st.folder,
    access: st.access,
    shared_with: ok,
    ...(failed.length ? { not_shared: failed } : {}),
    ...(st.anyone ? { anyone_with_link: !!st.linkOk, link: st.folder.link } : {}),
    shortcut_targets: { total: st.targets, shared: st.targetsShared, failed: st.targetsFailed },
    ...(st.problems.length ? { problems: st.problems } : {}),
  };
}
