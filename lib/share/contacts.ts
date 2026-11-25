import { callGoogle, CONTACTS_SCOPE, DriveError, OTHER_CONTACTS_SCOPE, type Account } from "@/lib/drive/api";
import { count, listing } from "@/lib/drive/engine";

/**
 * Finding someone's email address in the person's Google Contacts, so a Drive folder can be shared with them
 * ("share this with Riya"). Read-only, and only names and email addresses are asked for (readMask). Nothing is kept:
 * the matches go back to the AI app, the person picks one, and only then does share_drive_folder use it.
 *
 * Two lists: saved contacts (people:searchContacts, CONTACTS_SCOPE) and "Other contacts", people they've emailed but
 * never saved (otherContacts:search, OTHER_CONTACTS_SCOPE). Both are optional permissions ("c" and "o" in Account.ph).
 */

const PEOPLE = "https://people.googleapis.com/v1";
const READ_MASK = "names,emailAddresses";
const PER_LIST = 10;

const RECONNECT =
  "Remove Offload in your AI app's connector settings, add it again, and tick the Contacts boxes on Google's screen. " +
  "Or ask the person for the email address and pass it to share_drive_folder.";

export type ContactMatch = { name: string; email: string; saved: boolean; in_contacts_of: string };

type Person = { names?: { displayName?: string }[]; emailAddresses?: { value?: string }[] };
type SearchResponse = { results?: { person?: Person }[] };

/** Accounts whose contacts Offload may search. */
export const canSearchContacts = (a: Account) => !!a.ph && (a.ph.includes("c") || a.ph.includes("o"));

// Google's contact search works from a cache it fills on the first (empty) query: warm it once per account per
// server instance, as the People API asks, and retry once if a freshly warmed search comes back empty.
const warmed = new Set<string>();

async function searchList(acct: Account, saved: boolean, query: string): Promise<Person[]> {
  const path = saved ? "people:searchContacts" : "otherContacts:search";
  const scope = saved ? CONTACTS_SCOPE : OTHER_CONTACTS_SCOPE;
  const run = (q: string) => callGoogle<SearchResponse>(PEOPLE, scope, acct, "GET", path, { query: q, readMask: READ_MASK, pageSize: PER_LIST });
  const key = `${acct.e}|${saved ? "c" : "o"}`;
  let fresh = false;
  if (!warmed.has(key)) {
    await run("").catch(() => {});
    warmed.add(key);
    fresh = true;
  }
  let r = await run(query);
  if (fresh && !r.results?.length) {
    await new Promise((ok) => setTimeout(ok, 1500));
    r = await run(query);
  }
  return (r.results || []).map((x) => x.person).filter((p): p is Person => !!p);
}

const why = (e: unknown) =>
  e instanceof DriveError && e.status === 403
    ? "Google didn't allow it (the Contacts permission may be missing)."
    : e instanceof Error
      ? e.message
      : String(e);

/** Searches the contacts of `accounts` (each that allowed it) for `query`, a name or part of an email. */
export async function findContacts(accounts: Account[], query: string) {
  const q = query.replace(/\s+/g, " ").trim();
  if (!q) throw new Error("Say whose email to look for: a name, or part of their email address.");
  const able = accounts.filter(canSearchContacts);
  if (!able.length) {
    const who = accounts.length === 1 ? accounts[0].e : listing(accounts.map((a) => a.e));
    throw new Error(`${who} ${accounts.length === 1 ? "hasn't" : "haven't"} allowed Offload to look up contacts. ${RECONNECT}`);
  }

  const byEmail = new Map<string, ContactMatch>();
  const problems: { account: string; detail: string }[] = [];
  await Promise.all(
    able.flatMap((acct) =>
      [true, false]
        .filter((saved) => acct.ph!.includes(saved ? "c" : "o"))
        .map(async (saved) => {
          try {
            for (const p of await searchList(acct, saved, q)) {
              const name = p.names?.find((n) => n.displayName)?.displayName || "";
              for (const a of p.emailAddresses || []) {
                const email = String(a.value || "").trim().toLowerCase();
                if (!email || accounts.some((x) => x.e === email)) continue; // their own linked accounts aren't who they're sharing with
                const had = byEmail.get(email);
                if (!had || (saved && !had.saved) || (!had.name && name)) {
                  byEmail.set(email, { name: name || had?.name || "", email, saved: saved || !!had?.saved, in_contacts_of: had?.in_contacts_of || acct.e });
                }
              }
            }
          } catch (e) {
            problems.push({ account: acct.e, detail: `Couldn't search ${saved ? "contacts" : "other contacts"}: ${why(e)}` });
          }
        })
    )
  );

  const matches = [...byEmail.values()].sort((x, y) => Number(y.saved) - Number(x.saved) || x.name.localeCompare(y.name)).slice(0, 15);
  const searched = listing(able.map((a) => a.e));
  const skipped = accounts.filter((a) => !canSearchContacts(a)).map((a) => a.e);
  const message = matches.length
    ? `Found ${count(matches.length, "match", "matches")} for "${q}" in ${searched}'s contacts: ` +
      matches.map((m) => (m.name ? `${m.name} <${m.email}>` : m.email)).join(", ") +
      ". Ask the person which one is right before sharing anything."
    : `Nobody matching "${q}" in ${searched}'s contacts. Ask the person for the email address, or try another spelling or just a first name.`;
  return {
    message,
    query: q,
    matches,
    searched: able.map((a) => a.e),
    ...(skipped.length ? { not_searched: skipped, not_searched_why: "These accounts didn't allow Offload to look up contacts." } : {}),
    ...(problems.length ? { problems } : {}),
  };
}
