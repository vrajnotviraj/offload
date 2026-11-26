import { createSign } from "node:crypto";

/**
 * Early access: the first ACCESS_LIMIT people (100 by default) get in; everyone after joins a waitlist.
 *
 * Offload keeps no database, so the list lives in a Google Sheet the owner can read and edit:
 *   - "Users":    Email | Joined | Via                        (who's in; one row per person, by their main account)
 *   - "Waitlist": Email | Joined | Via | Name                  (who's waiting, in order)
 * To let someone in, move their row from Waitlist to Users (or raise ACCESS_LIMIT). To free a spot, delete a Users row.
 *
 * The server writes to it as a Google Cloud service account (GOOGLE_SERVICE_ACCOUNT_KEY: the key's JSON), with the
 * sheet (WAITLIST_SHEET_ID) shared with that account as an editor. Missing tabs and headers are made on first use.
 * Without those two variables the gate is off and everyone gets in (local development).
 */

export const USERS_TAB = "Users";
export const WAITLIST_TAB = "Waitlist";
const HEADERS: Record<string, string[]> = {
  [USERS_TAB]: ["Email", "Joined", "Via"],
  [WAITLIST_TAB]: ["Email", "Joined", "Via", "Name"],
};
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export const accessLimit = () => Math.max(0, Number(process.env.ACCESS_LIMIT || 100) || 100);

type Key = { client_email: string; private_key: string };

function config(): { key: Key; sheet: string } | null {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const sheet = process.env.WAITLIST_SHEET_ID;
  if (!raw || !sheet) return null;
  let key: Key;
  try {
    key = JSON.parse(raw);
  } catch {
    // Pasted base64 instead of the JSON itself.
    key = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  }
  if (!key.client_email || !key.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY isn't a service account key.");
  return { key: { ...key, private_key: key.private_key.replace(/\\n/g, "\n") }, sheet: sheet.trim() };
}

export const gateOn = () => {
  try {
    return !!config();
  } catch {
    return true;
  }
};

let cached: { token: string; until: number } | null = null;

async function serviceToken(key: Key): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: key.client_email,
    scope: SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`The waitlist sheet's service account couldn't sign in: ${body.error_description || body.error || res.status}`);
  cached = { token: body.access_token, until: Date.now() + (Number(body.expires_in) - 120) * 1000 };
  return cached.token;
}

async function sheets<T = any>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
  const c = config()!;
  const res = await fetch(`${SHEETS}/${c.sheet}${path}`, {
    method,
    headers: { authorization: `Bearer ${await serviceToken(c.key)}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google Sheets: ${out?.error?.message || res.status}`);
  return out as T;
}

let tabsReady = false;

/** Makes the Users and Waitlist tabs, with headers, if they aren't there yet. */
async function ensureTabs() {
  if (tabsReady) return;
  const meta = await sheets("GET", "?fields=sheets.properties.title");
  const have = new Set<string>((meta.sheets || []).map((s: any) => s.properties?.title));
  const missing = Object.keys(HEADERS).filter((t) => !have.has(t));
  if (missing.length) {
    await sheets("POST", ":batchUpdate", { requests: missing.map((title) => ({ addSheet: { properties: { title, gridProperties: { frozenRowCount: 1 } } } })) });
    for (const t of missing) await sheets("POST", `/values/${encodeURIComponent(`${t}!A1`)}:append?valueInputOption=RAW`, { values: [HEADERS[t]] });
  }
  tabsReady = true;
}

async function emails(tab: string): Promise<string[]> {
  const res = await sheets("GET", `/values/${encodeURIComponent(`${tab}!A2:A`)}?majorDimension=COLUMNS`);
  return ((res.values?.[0] || []) as string[]).map((e) => String(e).trim().toLowerCase()).filter(Boolean);
}

async function append(tab: string, row: string[]) {
  await sheets("POST", `/values/${encodeURIComponent(`${tab}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [row] });
}

export type Admission = { status: "in" } | { status: "waitlist"; position: number; limit: number };

const now = () => new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

/**
 * Lets `email` (the person's main account) in if it's already a user or there's a spot left, otherwise puts it on the
 * waitlist (once). Their other linked accounts don't take spots. If the sheet can't be reached, the person gets in:
 * a broken sheet shouldn't lock out people who already use Offload.
 */
export async function admit(email: string, via: string): Promise<Admission> {
  if (!config()) return { status: "in" };
  try {
    return await admitOrWait(email, via);
  } catch (e) {
    console.error("Early-access check failed, letting the person in:", e);
    return { status: "in" };
  }
}

async function admitOrWait(email: string, via: string): Promise<Admission> {
  const e = email.trim().toLowerCase();
  await ensureTabs();
  const users = await emails(USERS_TAB);
  if (users.includes(e)) return { status: "in" };
  if (users.length < accessLimit()) {
    await append(USERS_TAB, [e, now(), via]);
    return { status: "in" };
  }
  const w = await waitlist(e, via);
  return w.status === "in" ? w : { ...w, limit: accessLimit() };
}

/** Adds `email` to the waitlist if it isn't on it (or in) already. */
export async function waitlist(email: string, via: string, name = ""): Promise<{ status: "waitlist"; position: number } | { status: "in" }> {
  if (!config()) throw new Error("The waitlist isn't set up yet.");
  const e = email.trim().toLowerCase();
  await ensureTabs();
  const [users, waiting] = await Promise.all([emails(USERS_TAB), emails(WAITLIST_TAB)]);
  if (users.includes(e)) return { status: "in" };
  const at = waiting.indexOf(e);
  if (at >= 0) return { status: "waitlist", position: at + 1 };
  await append(WAITLIST_TAB, [e, now(), via, name]);
  return { status: "waitlist", position: waiting.length + 1 };
}

export function waitlistMessage(email: string, position: number) {
  return (
    `Offload is open to its first ${accessLimit()} people for now, and every spot is taken. ` +
    `${email} is on the waitlist (#${position}). You'll be let in as spots open up.`
  );
}
