import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addToFolder, count, createFolder, describeFind, findFiles, folderIn, folderSize, human, listing, storage, transfer } from "@/lib/drive/engine";
import type { SizeState, TransferState } from "@/lib/drive/engine";
import { packCursor, unpackCursor } from "./cursor";
import type { Account } from "./google";
import { accessToken } from "./google"; // importing it also registers the server-side Google token source
import {
  addToAlbum,
  copyPickedServer,
  copyResult,
  createAlbum,
  drivePreviews,
  driveTimeline,
  driveTimelineResult,
  inPeriod,
  MAX_PREVIEWS,
  pickedPreviews,
  pickedResult,
  picked,
  startPick,
  type CopyState,
  type DriveTimelineState,
  type PickToken,
  type Preview,
} from "@/lib/photos/connector";
import { CANT_DELETE_PHOTOS, googlePhotosUrl } from "@/lib/photos/engine";
import { MAX_GROUPS, runSort, sortResult, startSort, type SortState } from "@/lib/photos/sort";

/** How long one transfer_files call works before handing back a continue_token. */
const TRANSFER_BUDGET_MS = 40_000;
/** How long one photo_timeline or copy_google_photos call works before handing back a continue_token. */
const PHOTOS_BUDGET_MS = 35_000;

const INSTRUCTIONS = `Every result starts with "message": a plain summary you can pass on to the person as it is, adding detail from the rest of the result where it helps.

Getting started: when the person first brings Offload into a conversation without a clear task ("open Offload", "what can Offload do?"), call get_accounts, show their storage, and then offer these popular options as a short numbered list, so they can just pick one:
1. Free up space: find the biggest files in the fullest account and move them to the account with the most room.
2. Find a file: "where is my X?" across every linked account.
3. Photo timeline: how many photos and videos are in Drive, year by year and month by month.
4. Copy Google Photos to another account: pick photos and copy them over in original quality.
5. Sort photos into albums or folders: pick photos, group them (by person, trip, place) and file each group into its own album or Drive folder.
Leave out options that don't fit (with one account, nothing can move between accounts), and lead with the one their storage points to (an account almost full → free up space). When they already asked for something specific, do that instead of listing options.

Offload moves Google Drive files between the person's own Google accounts (2 to 5 of them, linked when the connector was added) by transferring ownership, which frees storage in the account they leave. The first linked account is their main account.

Storage: get_accounts returns every account's storage. Show it as a small table (account, used, total, free, % used, status) followed by one line on which account has the most room. Google can take a few hours to update these numbers after a move.

Finding things: call find_files without account to search every linked account at once; each result group says which account holds those files (the owner, whose storage they use). The folders and files Offload moved are tagged with where they came from and when (moved_here_from, moved_on); a moved folder's contents aren't tagged one by one, they're inside the tagged folder. find_files with moved_only lists them (kind=folders for the folders).

Moving: get_accounts → find_files / folder_size to pick what to move → confirm with the person, listing what will move, how much space it frees, and which account receives it → transfer_files. With more than two accounts, ask which account should receive the files unless the person said so; get_accounts shows which has the most room. If transfer_files returns done: false, call it again with only continue_token until done is true, and tell the person how far it's got.

Only files the sending account owns can be moved; files owned by anyone else are skipped. Moved items keep their folder structure; loose ones land in "Transferred from <sender>" in the receiving account's My Drive. A transfer can be undone by moving the items back. Nothing is deleted.

Folders: create_drive_folder makes an empty folder in any linked account's Drive (in My Drive, or inside parent_id) and returns its folder_id. add_to_drive_folder files things into a folder in the same account: how=move moves them there; how=shortcut leaves them where they are and adds a shortcut (no extra storage), which is how one file goes into several folders, since Drive keeps each file in one folder.

Photos come in two kinds, and Google treats them differently:
- Photos and videos stored in Google Drive: photo_timeline counts all of them, month by month and year by year (count, size, video length, cameras, busiest month and year), and gives preview_ids for each month. If it returns done: false, call it again with only continue_token. Show the years as a small table, then the months the person asks about.
- The Google Photos library: Google only lets apps see photos the person picks. pick_google_photos returns a picker_url: give it to the person as a link, ask them to choose photos (they can pick up to 2,000) and press Done, and wait for them to say they've finished before calling picked_photos. Don't call picked_photos repeatedly while they're picking. picked_photos gives the same month and year timeline for the picked photos.
- show_photos shows small previews in the chat: pass Drive file IDs (preview_ids from photo_timeline, or IDs from find_files with kind=media), or a photos_session with an optional period (2019, or 2019-07) for picked Google Photos. Each picked preview has an item number (its place in the whole pick): use those numbers when talking about photos and in copy_google_photos's items. Describe what's in them if the person asks.
- copy_google_photos copies picked Google Photos (all of them, or only items) into another linked account: its Google Photos (to=photos, the default) into an album, or its Google Drive (to=drive) into a folder. Album: album_id (from create_photos_album), album_title (a new one with that name), or by default a new "Copied from <account>". Folder: folder_id, or by default a new "Copied from <account> (Google Photos)". Confirm first. While done is false, call again with only continue_token. Each call returns copies: the new items' ids, by item number; keep them. Originals stay put; the person deletes them in Google Photos to free the space. The pick stays usable, so the same photos can also be copied to Drive. Drive photos are moved with transfer_files instead.
- create_photos_album makes an empty album in a linked account's Google Photos and returns its album_id.
- add_to_photos_album puts copies Offload made (ids from copy_google_photos's copies) into another album Offload made, in the same account. A photo in several albums is one copy and uses no extra storage, so copy each photo once and add it to the rest of its albums with add_to_photos_album, rather than copying it again.
- What Google doesn't allow, so don't offer it: listing or reading the person's albums, adding to albums they made in Google Photos, putting photos that were already in an account into an album, deleting anything from Google Photos. Offload only ever adds its own copies to its own albums; the person adds their existing photos in Google Photos.
- Sorting photos into groups (one per person, place, trip, anything): pick → show_photos (every page, with offset) → you work out the groups from what you see and list them for the person by item number, with a short description of each group rather than a name you guess → they confirm or correct → sort_photos with the groups. It makes an album and/or Drive folder per group in the receiving account, copies each photo once, and files it into every group it belongs to (one copy in several albums; in Drive, the file in its first group's folder and shortcuts in the rest). Offload itself doesn't recognise anyone: the groups are what you and the person agreed. Say when a match is a guess (small previews, similar outfits), and never name a person the person hasn't named. For one-off filing, create_photos_album / create_drive_folder, copy_google_photos and add_to_photos_album / add_to_drive_folder still work step by step.
- If a tool says an account hasn't allowed Google Photos, pass on its message: the person reconnects Offload and leaves the Google Photos boxes ticked.
- Offload can't delete anything from Google Photos, and Google doesn't let any app do it. Every Google Photos result's message ends by saying so, with a link to the account's Google Photos: always pass that part on, after every Google Photos action, so the person knows deleting the originals (to free the space) is something they do themselves in Google Photos. Never offer to delete them or suggest Offload will.`;

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Ends a Google Photos result's message with the reminder that Offload can't delete from Google Photos, and links `email`'s. */
function withPhotosNote<T extends object>(data: T, email?: string) {
  const link = email ? googlePhotosUrl(email) : "https://photos.google.com";
  const note = `${CANT_DELETE_PHOTOS} ${email ? `${email}'s Google Photos` : "Google Photos"}: ${link}`;
  const message = (data as { message?: unknown }).message;
  return {
    ...data,
    message: typeof message === "string" && message ? `${message} ${note}` : note,
    deleting_google_photos: { offload_can_delete: false, note: CANT_DELETE_PHOTOS, open_google_photos: link },
  };
}

const photosText = (data: object, email?: string) => text(withPhotosNote(data, email));

function failure(e: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
}

/** `site` is this deployment's address (e.g. https://offload.example), so AI apps can show Offload's icon and link. */
export function buildServer(accounts: Account[], site?: string): McpServer {
  const server = new McpServer(
    {
      name: "offload",
      title: "Offload",
      version: "1.5.0",
      description:
        "Move Google Drive files between your Google accounts, see how much space each one has, browse your photos month by month and year by year, copy Google Photos to another account's Google Photos or Drive, and sort them into new albums and folders.",
      ...(site
        ? {
            websiteUrl: site,
            icons: [
              { src: `${site}/icon-512.png`, mimeType: "image/png", sizes: ["512x512"] },
              { src: `${site}/icon-192.png`, mimeType: "image/png", sizes: ["192x192"] },
              { src: `${site}/icon.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
            ],
          }
        : {}),
    },
    { instructions: INSTRUCTIONS }
  );
  const main = accounts[0];
  const list = accounts.map((x) => x.e).join(", ");

  const find = (email: string): Account => {
    const e = email.trim().toLowerCase();
    const hit = accounts.find((x) => x.e === e);
    if (!hit) throw new Error(`${email} isn't linked. The linked accounts are ${list}.`);
    return hit;
  };
  const emailArg = (what: string) => z.string().optional().describe(`${what} One of: ${list}.`);

  server.registerTool(
    "get_accounts",
    {
      title: "Storage of every linked account",
      description:
        "Shows every linked Google account with its storage: used, total, free, % used, status (ok / almost full / full) and what's " +
        "using it (Drive, Drive trash, Gmail and Photos), plus totals and which account has the most room. Use it for " +
        "\"how much space do my accounts have?\" and before choosing where to move files.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const all = await Promise.all(accounts.map(storage));
        const rows = all.map(({ bytes, ...row }, i) => ({ ...row, role: i === 0 ? "main" : "linked" }));
        const limited = all.filter((s) => s.bytes.total !== null);
        const sum = (f: (s: (typeof all)[number]) => number) => limited.reduce((n, s) => n + f(s), 0);
        const byFree = [...limited].sort((x, y) => y.bytes.free! - x.bytes.free!);
        const byUse = [...limited].sort((x, y) => y.percent_used! - x.percent_used!);
        const unlimited = all.filter((s) => s.bytes.total === null).map((s) => s.email);
        const totalLine = limited.length
          ? `${human(sum((s) => s.bytes.used))} used of ${human(sum((s) => s.bytes.total!))}, ${human(sum((s) => s.bytes.free!))} free` +
            (unlimited.length ? ` (not counting ${listing(unlimited)}, which ${unlimited.length === 1 ? "has" : "have"} unlimited storage)` : "")
          : "all on unlimited plans";
        const tight = all.filter((s) => s.status === "full" || s.status === "almost full");
        const message = [
          `${count(all.length, "linked account")}: ${totalLine}.`,
          ...tight.map((s) => `${s.email} is ${s.status} (${s.percent_used}%).`),
          ...(byFree[0] && all.length > 1 ? [`${byFree[0].email} has the most room (${byFree[0].free} free).`] : []),
        ].join(" ");
        return text({
          message,
          accounts: rows,
          total: limited.length
            ? {
                used: human(sum((s) => s.bytes.used)),
                total: human(sum((s) => s.bytes.total!)),
                free: human(sum((s) => s.bytes.free!)),
                ...(limited.length < all.length ? { note: "Accounts with unlimited plans aren't in the total." } : {}),
              }
            : null,
          most_free_space: byFree[0] ? `${byFree[0].email} (${byFree[0].free} free)` : null,
          fullest: byUse[0] ? `${byUse[0].email} (${byUse[0].percent_used}% used)` : null,
          note: "Figures come from Google and can take a few hours to catch up after files move.",
        });
      } catch (e) {
        return failure(e);
      }
    }
  );

  server.registerTool(
    "find_files",
    {
      title: "Find files in your accounts",
      description:
        "Finds Drive files or folders and says which linked account each one is in (the account that owns it, whose storage it uses). " +
        "Leave account out to search every linked account at once: use that for \"where is my X?\" and for the biggest files overall. " +
        "Biggest first by default. Filter by kind, min_size_mb, name_contains or folder_id. moved_only lists the files (or, with kind=folders, " +
        "the folders) Offload moved "+
        "into an account, with where they came from and when (moved_here_from, moved_on); files inside a moved folder are covered by the folder. Returns IDs for transfer_files.",
      inputSchema: {
        account: emailArg("Search only this account. Leave out to search all of them."),
        kind: z
          .enum(["all", "images", "videos", "media", "documents", "folders"])
          .default("all")
          .describe("media = images and videos. documents = Google Docs, Sheets, Slides and other Google files."),
        min_size_mb: z.number().min(0).optional().describe("Only files at least this big, in MB."),
        name_contains: z.string().max(200).optional().describe("Matches whole words at the start of names, as Drive search does."),
        folder_id: z.string().optional().describe("Only items directly inside this folder."),
        moved_only: z.boolean().default(false).describe("Only items Offload moved here from another linked account."),
        sort: z.enum(["largest", "newest", "name"]).default("largest"),
        limit: z.number().int().min(1).max(100).default(25).describe("Per account."),
        page_token: z.string().optional().describe("next_page_token from a previous result. Needs account set to that result's account."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ account, moved_only, ...args }) => {
      try {
        if (args.page_token && !account) throw new Error("page_token belongs to one account: pass that account too.");
        const targets = account ? [find(account)] : accounts;
        const results = await Promise.all(
          targets.map((acct) => {
            const others = accounts.filter((x) => x.e !== acct.e).map((x) => x.e);
            return findFiles(acct, { ...args, moved_from: moved_only ? others : undefined });
          })
        );
        if (results.length === 1) return text(results[0]);
        const found = results.reduce((n, r) => n + r.count, 0);
        const filter = { ...args, moved_from: moved_only ? ["x"] : undefined };
        const where = results.filter((r) => r.count).map((r) => `${r.count} in ${r.account}${args.kind === "folders" ? "" : ` (${r.total_size})`}`);
        const empty = results.filter((r) => !r.count).map((r) => r.account);
        const message = found
          ? `Found ${describeFind(filter, found)}: ${listing(where)}.` + (empty.length ? ` Nothing in ${listing(empty)}.` : "") +
            (results.some((r) => r.next_page_token) ? " There are more; ask for the next page of an account to see them." : "")
          : `No ${describeFind(filter, 2).replace(/^2 /, "")} in any linked account.`;
        return text({
          message,
          searched: accounts.map((x) => x.e),
          note: "Each file is in exactly one account: the one that owns it. Results are per account.",
          results,
        });
      } catch (e) {
        return failure(e);
      }
    }
  );

  server.registerTool(
    "folder_size",
    {
      title: "Folder size",
      description:
        "Adds up the files an account owns inside a folder, subfolders included: the space moving that folder would free.",
      inputSchema: {
        folder_id: z.string(),
        account: emailArg(`Account the folder is in. Defaults to ${main.e}.`),
        continue_token: z.string().optional().describe("From a previous call on a big folder."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const acct = args.account ? find(args.account) : main;
        const prev = args.continue_token ? unpackCursor<SizeState>(args.continue_token, "size") : undefined;
        const { state, ...res } = await folderSize(acct, args.folder_id, prev);
        return text(state ? { ...res, continue_token: packCursor(state), note: "Big folder: call folder_size again with continue_token." } : res);
      } catch (e) {
        return failure(e);
      }
    }
  );

  server.registerTool(
    "create_drive_folder",
    {
      title: "Make an empty Drive folder",
      description:
        "Makes an empty folder in one linked account's Google Drive: in My Drive, or inside another folder (parent_id, from find_files " +
        "with kind=folders). Returns its folder_id and link. Use it when the person wants a new folder, for example to sort things into.",
      inputSchema: {
        name: z.string().min(1).max(255).describe("The new folder's name."),
        account: emailArg(`Account whose Drive gets the folder. Defaults to ${main.e}.`),
        parent_id: z.string().optional().describe("Folder to put it in. Leave out for My Drive."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        return text(await createFolder(args.account ? find(args.account) : main, args.name, args.parent_id));
      } catch (e) {
        return failure(e);
      }
    }
  );

  server.registerTool(
    "add_to_drive_folder",
    {
      title: "Put files into a Drive folder",
      description:
        "Puts Drive files or folders into a folder, all in one linked account's Drive. how=move moves each one there (out of where it was). " +
        "how=shortcut leaves it where it is and adds a shortcut to it in the folder, which uses no storage: use that to put one file in " +
        "several folders, because Drive keeps each file in exactly one folder. IDs come from find_files, or from copy_google_photos's copies " +
        "(with to=drive). To move files to another account, use transfer_files instead.",
      inputSchema: {
        ids: z.array(z.string()).min(1).max(200).describe("Drive file or folder IDs."),
        folder_id: z.string().describe("The folder to put them in (from create_drive_folder or find_files with kind=folders). root = My Drive."),
        how: z.enum(["move", "shortcut"]).default("move"),
        account: emailArg(`Account whose Drive the files and the folder are in. Defaults to ${main.e}.`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        return text(await addToFolder(args.account ? find(args.account) : main, args.ids, args.folder_id, args.how));
      } catch (e) {
        return failure(e);
      }
    }
  );

  const two = accounts.length === 2;
  server.registerTool(
    "transfer_files",
    {
      title: "Move files to another account",
      description:
        "Moves files and folders (with everything inside) from one linked account to another by transferring ownership: " +
        "the sending account requests it and the receiving account accepts it in the same step, so nothing else has to be done. " +
        "This frees the space in the sending account. Confirm with the person first. Big jobs run in steps: while done is false, " +
        "call again with only continue_token. Safe to repeat: items already moved are skipped.",
      inputSchema: {
        ids: z.array(z.string()).max(500).optional().describe("File and folder IDs from find_files. Not needed with continue_token."),
        from_account: emailArg(`Account the files move out of (the one being freed). Defaults to ${main.e}.`),
        to_account: emailArg(
          two
            ? "Account that receives the files. Defaults to the other linked account."
            : "Account that receives the files. Required: ask the person if they haven't said."
        ),
        continue_token: z.string().optional().describe("From a previous call that returned done: false. Remembers both accounts."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        let from: Account | undefined;
        let to: Account | undefined;
        if (!args.continue_token) {
          from = args.from_account ? find(args.from_account) : main;
          if (args.to_account) to = find(args.to_account);
          else if (two) to = accounts.find((x) => x.e !== from!.e);
          else {
            const options = accounts.filter((x) => x.e !== from!.e).map((x) => x.e).join(", ");
            throw new Error(`Which account should receive the files? Pass to_account: one of ${options}. get_accounts shows which has the most room.`);
          }
        }
        const prev = args.continue_token ? unpackCursor<TransferState>(args.continue_token, "transfer") : undefined;
        const { state, ...res } = await transfer(accounts, { ids: args.ids, from, to, state: prev, budgetMs: TRANSFER_BUDGET_MS });
        return text(state ? { ...res, continue_token: packCursor(state) } : res);
      } catch (e) {
        return failure(e);
      }
    }
  );

  /* ------------------------------ Photos ------------------------------ */

  const indexOf = (email: string) => accounts.indexOf(find(email));
  const token = (a: Account, _scope?: string, force?: boolean) => accessToken(a, !!force);
  const openPick = (t: string) => unpackCursor<PickToken>(t, "pick");
  const previewContent = (data: object, previews: Preview[]) => ({
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
      ...previews.map((p) => ({ type: "image" as const, data: p.data, mimeType: p.mime })),
    ],
  });

  server.registerTool(
    "photo_timeline",
    {
      title: "Photo and video timeline (Google Drive)",
      description:
        "Counts every photo and video stored in Google Drive, by year and by month (when each was taken, or else added): photos, videos, " +
        "space used, total video length, the cameras used, the busiest month and year, and a split by account. Leave account out to " +
        "cover every linked account. With group_by=month, each month comes with preview_ids for show_photos. Big libraries run in steps: " +
        "while done is false, call again with only continue_token. For the Google Photos library, use pick_google_photos instead.",
      inputSchema: {
        account: emailArg("Only this account. Leave out for all of them."),
        group_by: z.enum(["month", "year"]).default("month").describe("month also includes the year totals."),
        continue_token: z.string().optional().describe("From a previous call that returned done: false."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const prev = args.continue_token ? unpackCursor<DriveTimelineState & { g: "month" | "year"; ts: number[] }>(args.continue_token, "dtl") : undefined;
        const targets = prev?.ts || (args.account ? [indexOf(args.account)] : accounts.map((_, i) => i));
        const group_by = prev?.g || args.group_by;
        const st = await driveTimeline(accounts, targets, prev, PHOTOS_BUDGET_MS);
        const res = driveTimelineResult(st, accounts, targets, group_by);
        return text(res.done ? res : { ...res, continue_token: packCursor({ ...st, g: group_by, ts: targets }) });
      } catch (e) {
        return failure(e);
      }
    }
  );

  server.registerTool(
    "pick_google_photos",
    {
      title: "Pick photos from Google Photos",
      description:
        "Starts choosing photos from an account's Google Photos library. Google only lets apps see photos the person picks, so this " +
        "returns a picker_url: give it to the person as a link to open (in a browser signed in to that account), choose photos and videos " +
        "(up to 2,000) and press Done. Then wait for them to say they're done and call picked_photos with the photos_session.",
      inputSchema: {
        account: emailArg(`Whose Google Photos to pick from. Defaults to ${main.e}.`),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const idx = args.account ? indexOf(args.account) : 0;
        const { token: t, url } = await startPick(accounts, idx);
        return photosText(
          {
            message: `Open this link to choose photos from ${accounts[idx].e}'s Google Photos, then press Done and tell me: ${url}`,
            picker_url: url,
            account: accounts[idx].e,
            photos_session: packCursor(t),
            note: "Ask the person to say when they've finished picking, then call picked_photos. The link works for a limited time.",
          },
          accounts[idx].e
        );
      } catch (e) {
        return failure(e);
      }
    }
  );

  server.registerTool(
    "picked_photos",
    {
      title: "Timeline of picked Google Photos",
      description:
        "After the person has picked photos with pick_google_photos: a timeline of what they picked, by year and by month (photos, videos, " +
        "cameras, busiest month and year). If they haven't pressed Done yet, it says so: ask them to finish rather than calling again straight away.",
      inputSchema: {
        photos_session: z.string().describe("From pick_google_photos."),
        group_by: z.enum(["month", "year"]).default("month"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const t = openPick(args.photos_session);
        const r = await picked(accounts, t);
        if (!r.ready) {
          return photosText(
            {
              message: `Nothing picked yet: open the link from pick_google_photos, choose photos in ${accounts[t.a].e}'s Google Photos and press Done, then tell me.`,
              ready: false,
            },
            accounts[t.a].e
          );
        }
        return photosText({ ready: true, ...pickedResult(r.items, accounts, t.a, args.group_by) }, accounts[t.a].e);
      } catch (e) {
        return failure(e);
      }
    }
  );

  server.registerTool(
    "show_photos",
    {
      title: "Show photos",
      description:
        `Shows up to ${MAX_PREVIEWS} small previews in the chat, as images you can see and describe. Either pass ids (Drive photos or videos: ` +
        "preview_ids from photo_timeline, or IDs from find_files with kind=media), or a photos_session from pick_google_photos with an " +
        "optional period (a year like 2019 or a month like 2019-07). Videos show a still frame.",
      inputSchema: {
        ids: z.array(z.string()).max(MAX_PREVIEWS).optional().describe("Drive file IDs."),
        photos_session: z.string().optional().describe("From pick_google_photos, for picked Google Photos."),
        period: z
          .string()
          .regex(/^\d{4}(-\d{2})?$/)
          .optional()
          .describe("With photos_session: only items taken in this year (2019) or month (2019-07)."),
        limit: z.number().int().min(1).max(MAX_PREVIEWS).default(8),
        offset: z.number().int().min(0).default(0).describe("With photos_session: skip this many, to see the next ones."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        if (args.photos_session) {
          const t = openPick(args.photos_session);
          const r = await picked(accounts, t);
          if (!r.ready) return photosText({ message: "Nothing picked yet: ask the person to finish picking and press Done.", ready: false }, accounts[t.a].e);
          const match = inPeriod(r.items, args.period);
          const slice = match.slice(args.offset, args.offset + args.limit);
          const previews = await pickedPreviews(accounts[t.a], slice, token, slice.map((it) => r.items.indexOf(it) + 1));
          const shown = args.offset + slice.length;
          const message = !match.length
            ? `No picked photos ${args.period ? `from ${args.period}` : ""}.`.replace(" .", ".")
            : `Showing ${count(previews.length, "preview")} of ${count(match.length, "picked item")}` +
              (args.period ? ` from ${args.period}` : "") + (shown < match.length ? `; pass offset ${shown} for the next ones.` : ".");
          return previewContent(
            withPhotosNote(
              {
                message,
                previews: previews.map((p) => ({ item: p.item, name: p.name, taken: p.taken, video: p.video })),
                note: "item is each one's number in the whole pick, in the same order as the images. copy_google_photos takes these numbers as items.",
                ...(shown < match.length ? { next_offset: shown } : {}),
              },
              accounts[t.a].e
            ),
            previews
          );
        }
        if (!args.ids?.length) throw new Error("Pass ids (Drive file IDs) or a photos_session.");
        const { previews, missing } = await drivePreviews(accounts, args.ids.slice(0, args.limit), (a) => token(a));
        const message =
          `Showing ${count(previews.length, "preview")}.` +
          (missing.length ? ` ${count(missing.length, "item")} had no preview or couldn't be found.` : "");
        return previewContent(
          { message, previews: previews.map((p, i) => ({ n: i + 1, name: p.name, taken: p.taken, account: p.account, video: p.video })) },
          previews
        );
      } catch (e) {
        return failure(e);
      }
    }
  );

  server.registerTool(
    "copy_google_photos",
    {
      title: "Copy picked Google Photos to another account",
      description:
        "Copies photos and videos picked with pick_google_photos (all of them, or only the item numbers in items) in original quality into " +
        "another linked account: into its Google Photos (to=photos), in an album, or into its Google Drive (to=drive), in a folder. " +
        "Album: album_id (from create_photos_album), album_title (makes a new one with that name), or by default a new album " +
        "\"Copied from <account>\". Folder: folder_id, or by default a new folder \"Copied from <account> (Google Photos)\". " +
        "Google Photos has no ownership transfer, so this is a copy: the originals stay until the person deletes them, and the copies use the " +
        "receiving account's storage. Each call returns copies: the new items' ids by item number, for add_to_photos_album or add_to_drive_folder. " +
        "Confirm with the person first. Big jobs run in steps: while done is false, call again with only continue_token.",
      inputSchema: {
        photos_session: z.string().optional().describe("From pick_google_photos. Not needed with continue_token."),
        items: z
          .array(z.number().int().min(1))
          .max(2000)
          .optional()
          .describe("Only these item numbers (from show_photos). Leave out to copy everything picked."),
        to: z.enum(["photos", "drive"]).default("photos").describe("photos = the receiving account's Google Photos; drive = its Google Drive."),
        to_account: emailArg(
          two
            ? "Account that receives the copies. Defaults to the other linked account. With to=drive it can be the same account."
            : "Account that receives the copies. Required: ask the person if they haven't said. With to=drive it can be the same account."
        ),
        album_id: z.string().optional().describe("to=photos: an album Offload made in the receiving account (create_photos_album)."),
        album_title: z.string().min(1).max(500).optional().describe("to=photos: make a new album with this name for the copies."),
        folder_id: z.string().optional().describe("to=drive: the folder in the receiving account's Drive to put the copies in."),
        continue_token: z.string().optional().describe("From a previous call that returned done: false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        let st: CopyState;
        if (args.continue_token) st = unpackCursor<CopyState>(args.continue_token, "pcopy");
        else {
          if (!args.photos_session) throw new Error("Pass the photos_session from pick_google_photos.");
          const toDrive = args.to === "drive";
          if (!toDrive && args.folder_id) throw new Error("folder_id is for to=drive. For Google Photos, pass album_id or album_title.");
          if (toDrive && (args.album_id || args.album_title)) throw new Error("Albums are for to=photos. For Drive, pass folder_id.");
          if (args.album_id && args.album_title) throw new Error("Pass album_id (an album Offload made) or album_title (a new album), not both.");
          const t = openPick(args.photos_session);
          let to: number;
          if (args.to_account) to = indexOf(args.to_account);
          else if (two) to = t.a === 0 ? 1 : 0;
          else {
            const options = accounts.filter((_, i) => toDrive || i !== t.a).map((x) => x.e).join(", ");
            throw new Error(`Which account should receive the copies? Pass to_account: one of ${options}. get_accounts shows which has the most room.`);
          }
          if (to === t.a && !toDrive) throw new Error("Pick a different account to copy to: that's the one the photos are in.");
          const r = await picked(accounts, t);
          if (!r.ready) return photosText({ message: "Nothing picked yet: ask the person to finish picking and press Done.", done: false }, accounts[t.a].e);
          let pick: number[] | null = null;
          if (args.items?.length) {
            const outside = args.items.filter((n) => n > r.items.length);
            if (outside.length) {
              throw new Error(`There ${r.items.length === 1 ? "is 1 picked item" : `are ${r.items.length} picked items`}, so ${listing(outside.map(String))} ${outside.length === 1 ? "isn't one" : "aren't"}. show_photos lists the item numbers.`);
            }
            pick = [...new Set(args.items)].map((n) => n - 1);
          }
          let folder: CopyState["folder"] = null;
          if (toDrive && args.folder_id) {
            const f = await folderIn(accounts[to], args.folder_id);
            folder = { id: f.id, name: f.name, link: f.id === "root" ? "https://drive.google.com/drive/my-drive" : `https://drive.google.com/drive/folders/${f.id}` };
          }
          st = {
            k: "pcopy",
            a: t.a,
            to,
            id: t.id,
            dest: toDrive ? "drive" : "photos",
            pick,
            next: 0,
            open: [],
            album: args.album_id ? { id: args.album_id.trim(), url: "", own: true } : null,
            ...(args.album_title ? { albumTitle: args.album_title.replace(/\s+/g, " ").trim() } : {}),
            folder,
            total: pick ? pick.length : r.items.length,
            copied: 0,
            failed: 0,
            bytes: 0,
            errors: [],
          };
        }
        const { done, message, made } = await copyPickedServer(accounts, st, PHOTOS_BUDGET_MS, token);
        const res = copyResult(st, accounts, done, message, made);
        return photosText(done ? res : { ...res, continue_token: packCursor(st) }, accounts[st.a].e);
      } catch (e) {
        return failure(e);
      }
    }
  );

  server.registerTool(
    "create_photos_album",
    {
      title: "Make an empty Google Photos album",
      description:
        "Makes an empty album in one linked account's Google Photos. Returns its album_id and link. Offload can fill it with photos it " +
        "copies into that account (copy_google_photos with album_id, or add_to_photos_album for copies it already made). Google doesn't " +
        "let Offload add photos that were already in the account: the person adds those in Google Photos.",
      inputSchema: {
        title: z.string().min(1).max(500).describe("The new album's name."),
        account: emailArg(`Account whose Google Photos gets the album. Defaults to ${main.e}.`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const acct = args.account ? find(args.account) : main;
        return photosText(await createAlbum(acct, args.title), acct.e);
      } catch (e) {
        return failure(e);
      }
    }
  );

  server.registerTool(
    "add_to_photos_album",
    {
      title: "Add copied photos to another album",
      description:
        "Adds photos and videos Offload copied (the ids in copy_google_photos's copies) to an album Offload made (album_id from " +
        "create_photos_album or copy_google_photos), in the same account's Google Photos. The same copy can be in many albums and uses no " +
        "extra storage, so use this instead of copying a photo again. Google doesn't allow it for photos or albums Offload didn't make.",
      inputSchema: {
        album_id: z.string().describe("An album Offload made in this account."),
        media_item_ids: z.array(z.string()).min(1).max(500).describe("ids from copy_google_photos's copies."),
        account: emailArg("Account whose Google Photos the album and the copies are in (copy_google_photos's to)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const acct = args.account ? find(args.account) : null;
        if (!acct) throw new Error("Which account's Google Photos is the album in? Pass account (the to account from copy_google_photos).");
        return photosText(await addToAlbum(acct, args.album_id.trim(), args.media_item_ids), acct.e);
      } catch (e) {
        return failure(e);
      }
    }
  );

  server.registerTool(
    "sort_photos",
    {
      title: "Sort picked Google Photos into albums or folders",
      description:
        "Sorts photos picked with pick_google_photos into groups you and the person agreed (for example one per person in them), in another " +
        "linked account: an album per group in its Google Photos (to=photos), a folder per group in its Google Drive (to=drive, inside one " +
        "parent folder), or both. Each photo is copied once and filed into every group it's in, so a photo in several groups uses its storage " +
        "once. Also makes an album (or the parent folder) called title holding every sorted photo. Groups are item numbers from show_photos; " +
        "Offload doesn't recognise faces itself. Confirm the groups and the account with the person first. Big jobs run in steps: while done " +
        "is false, call again with only continue_token.",
      inputSchema: {
        photos_session: z.string().optional().describe("From pick_google_photos. Not needed with continue_token."),
        groups: z
          .array(
            z.object({
              name: z.string().min(1).max(200).describe("The album or folder name, e.g. \"Person 1\" or a name the person gave."),
              items: z.array(z.number().int().min(1)).min(1).max(2000).describe("Item numbers (from show_photos) of the photos in this group."),
            })
          )
          .min(1)
          .max(MAX_GROUPS)
          .optional()
          .describe("One entry per album or folder. A photo can be in several groups. Not needed with continue_token."),
        to: z.enum(["photos", "drive", "both"]).default("photos").describe("photos = albums in Google Photos; drive = folders in Google Drive; both."),
        to_account: emailArg(
          two
            ? "Account that receives the sorted copies. Defaults to the other linked account. With to=drive it can be the same account."
            : "Account that receives the sorted copies. Required: ask the person if they haven't said. With to=drive it can be the same account."
        ),
        title: z.string().min(1).max(255).optional().describe("Name for the album of all sorted photos and the parent Drive folder. Defaults to \"Sorted from <account>\"."),
        parent_id: z.string().optional().describe("to=drive or both: a folder in the receiving account's Drive to make the parent folder in. Defaults to My Drive."),
        continue_token: z.string().optional().describe("From a previous call that returned done: false."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        let st: SortState;
        if (args.continue_token) st = unpackCursor<SortState>(args.continue_token, "psort");
        else {
          if (!args.photos_session) throw new Error("Pass the photos_session from pick_google_photos.");
          if (!args.groups?.length) throw new Error("Pass groups: a name and item numbers for each album or folder.");
          const t = openPick(args.photos_session);
          const dests: ("photos" | "drive")[] = args.to === "both" ? ["photos", "drive"] : [args.to];
          let to: number;
          if (args.to_account) to = indexOf(args.to_account);
          else if (two) to = t.a === 0 ? 1 : 0;
          else {
            const options = accounts.filter((_, i) => i !== t.a).map((x) => x.e).join(", ");
            throw new Error(`Which account should receive the sorted copies? Pass to_account: one of ${options}.`);
          }
          const s = await startSort(accounts, t, { to, dests, groups: args.groups, title: args.title, parentId: args.parent_id });
          if (!s.ready) return photosText({ message: "Nothing picked yet: ask the person to finish picking and press Done.", done: false }, accounts[t.a].e);
          st = s.st;
        }
        const done = await runSort(accounts, st, PHOTOS_BUDGET_MS, token);
        const res = sortResult(st, accounts, done);
        return photosText(done ? res : { ...res, continue_token: packCursor(st) }, accounts[st.a].e);
      } catch (e) {
        return failure(e);
      }
    }
  );

  /* ------------------------- Starter prompts ------------------------- */
  // Shown by AI apps that list a connector's prompts (often as slash commands or in a + menu): the popular things to do.

  const starter = (name: string, title: string, description: string, ask: string) =>
    server.registerPrompt(name, { title, description }, () => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: ask } }],
    }));

  starter(
    "free_up_space",
    "Free up space",
    "Find the biggest files in your fullest Google account and move them to the one with the most room.",
    "Use Offload to show the storage of my linked Google accounts, then find the biggest files in the fullest one and suggest what to move to the account with the most room. Ask me before moving anything."
  );
  starter(
    "find_a_file",
    "Find a file",
    "Search every linked Google account at once and say which one a file is in.",
    "Use Offload to help me find a file across all my linked Google accounts. Ask me what I'm looking for."
  );
  starter(
    "photo_timeline",
    "Photo timeline",
    "See how many photos and videos are in your Drive, year by year and month by month.",
    "Use Offload to show a timeline of the photos and videos in my Google Drive, year by year, and tell me my busiest year and month."
  );
  starter(
    "copy_google_photos",
    "Copy Google Photos to another account",
    "Pick photos in Google Photos and copy them to another of your accounts in original quality.",
    "Use Offload to copy photos from my Google Photos to my other Google account. Start the picker and tell me what to do."
  );
  starter(
    "sort_photos",
    "Sort photos into albums or folders",
    "Pick photos, group them by person, trip or place, and file each group into its own album or Drive folder.",
    "Use Offload to sort photos from my Google Photos into albums (or Drive folders) by group, for example one per person. Start the picker, then show me the groups you see before making anything."
  );

  return server;
}
