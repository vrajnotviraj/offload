"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LIBRARY_SCOPE, type Account } from "@/lib/drive/api";
import { allowScope, hasScope } from "@/lib/drive/browserAuth";
import { listPicked, type Picked } from "@/lib/photos/engine";
import { pickedThumb, sortTagged, type TagSortProgress, type TagSortResult } from "@/lib/photos/tagSort";

/**
 * Sort picked Google Photos by person, by hand: add the people, choose one, tap every photo they're in, then the next.
 * Then choose the account and albums and/or Drive folders, and Offload copies each photo once and files it into every
 * person's album or folder (lib/photos/tagSort.ts → lib/photos/sort.ts). Offload doesn't look at faces: Google's Photos API
 * policy doesn't allow apps to make face groups, so who's in each photo is the person's own call.
 */

type Person = { id: string; name: string };
type Stage = { k: "tag" } | { k: "where" } | { k: "running"; p: TagSortProgress } | { k: "done"; r: TagSortResult; to: string } | { k: "failed"; error: string };

const COLORS = ["#E9A800", "#4C7BD9", "#C8553D", "#3E9B6E", "#8E5CC4", "#D46A9F", "#2F8F9D", "#9A6516"];
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

export function PhotoTagger({
  from,
  accounts,
  sessionId,
  items: initialItems,
  onClose,
}: {
  from: Account;
  accounts: Account[];
  sessionId: string;
  items: Picked[];
  onClose: () => void;
}) {
  const [items, setItems] = useState(initialItems);
  const [people, setPeople] = useState<Person[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [tags, setTags] = useState<Map<number, Set<string>>>(new Map()); // item index → person ids
  const [newName, setNewName] = useState("");
  const [filter, setFilter] = useState<"all" | "untagged" | "active">("all");
  const [stage, setStage] = useState<Stage>({ k: "tag" });
  const [dest, setDest] = useState("");
  const [albums, setAlbums] = useState(false);
  const [folders, setFolders] = useState(true);
  const [title, setTitle] = useState(`People, ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`);
  const [, rerender] = useState(0);
  const [error, setError] = useState("");
  const last = useRef<number | null>(null);
  const nextId = useRef(1);

  const colorOf = (id: string) => COLORS[(people.findIndex((p) => p.id === id) + COLORS.length) % COLORS.length];
  const countFor = (id: string) => [...tags.values()].filter((s) => s.has(id)).length;
  const activePerson = people.find((p) => p.id === active) || null;

  const addPerson = () => {
    const name = newName.replace(/\s+/g, " ").trim();
    if (!name) return;
    if (people.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      setError(`There's already someone called ${name}.`);
      return;
    }
    const id = `p${nextId.current++}`;
    setPeople((ps) => [...ps, { id, name }]);
    setActive(id);
    setFilter("all");
    setNewName("");
    setError("");
  };

  const removePerson = (id: string) => {
    setPeople((ps) => ps.filter((p) => p.id !== id));
    setTags((m) => {
      const n = new Map<number, Set<string>>();
      for (const [i, s] of m) {
        const c = new Set(s);
        c.delete(id);
        if (c.size) n.set(i, c);
      }
      return n;
    });
    if (active === id) setActive(null);
  };

  /** Tags or untags the active person on item `i`; with shift, on every item from the last one tapped to this one. */
  const tap = (i: number, shift: boolean) => {
    if (!active) {
      setError("Add a person first (or choose one), then tap the photos they're in.");
      return;
    }
    setError("");
    const turnOn = !tags.get(i)?.has(active);
    const range = shift && last.current !== null ? visible.slice(Math.min(visible.indexOf(last.current), visible.indexOf(i)), Math.max(visible.indexOf(last.current), visible.indexOf(i)) + 1) : [i];
    setTags((m) => {
      const n = new Map(m);
      for (const k of range) {
        const s = new Set(n.get(k) || []);
        if (turnOn) s.add(active);
        else s.delete(active);
        if (s.size) n.set(k, s);
        else n.delete(k);
      }
      return n;
    });
    last.current = i;
  };

  const visible = useMemo(
    () =>
      items
        .map((_, i) => i)
        .filter((i) => (filter === "untagged" ? !tags.get(i)?.size : filter === "active" ? !!active && !!tags.get(i)?.has(active) : true)),
    [items, filter, tags, active]
  );

  const groups = people
    .map((p) => ({ name: p.name, items: [...tags.entries()].filter(([, s]) => s.has(p.id)).map(([i]) => i + 1) }))
    .filter((g) => g.items.length);
  const tagged = new Set([...tags.entries()].filter(([, s]) => s.size).map(([i]) => i)).size;

  // Download links for picked items last an hour: fetch fresh ones when a preview finds its link has run out.
  const refreshing = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => {
    if (!refreshing.current) {
      refreshing.current = listPicked(from, sessionId)
        .then((fresh) => {
          const byId = new Map(fresh.map((x) => [x.id, x]));
          setItems((cur) => cur.map((x) => byId.get(x.id) || x));
        })
        .finally(() => setTimeout(() => (refreshing.current = null), 30_000));
    }
    return refreshing.current;
  }, [from, sessionId]);

  const run = async () => {
    const to = accounts.find((a) => a.e === dest);
    if (!to) return;
    const dests = [...(albums ? (["photos"] as const) : []), ...(folders ? (["drive"] as const) : [])];
    setStage({ k: "running", p: { done: 0, total: 1, message: "Starting…" } });
    try {
      const r = await sortTagged(from, to, sessionId, groups, { dests, title: title.trim() || "People" }, (p) => setStage({ k: "running", p }));
      setStage({ k: "done", r, to: to.e });
    } catch (e) {
      setStage({ k: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  };

  /* ------------------------------ Tagging ------------------------------ */

  if (stage.k === "tag") {
    return (
      <div>
        <p>
          Add the people you want to sort by. Choose one, then tap every photo they&rsquo;re in (shift-click tags a run of
          photos). Then the next person. A photo can belong to several people.
        </p>
        <div className="tg-people" role="group" aria-label="People">
          {people.map((p) => (
            <span key={p.id} className={`tg-chip${p.id === active ? " is-on" : ""}`} style={{ ["--c" as string]: colorOf(p.id) }}>
              <button onClick={() => setActive(p.id === active ? null : p.id)} aria-pressed={p.id === active}>
                <i aria-hidden="true">{initials(p.name)}</i>
                {p.name} <b>{countFor(p.id)}</b>
              </button>
              <button className="tg-x" onClick={() => removePerson(p.id)} aria-label={`Remove ${p.name}`}>
                ×
              </button>
            </span>
          ))}
          <form
            className="tg-add"
            onSubmit={(e) => {
              e.preventDefault();
              addPerson();
            }}
          >
            <input value={newName} maxLength={80} placeholder={people.length ? "Add someone else" : "Add a person, e.g. Riya"} aria-label="Name of a person to add" onChange={(e) => setNewName(e.target.value)} />
            <button className="btn btn-quiet" type="submit" disabled={!newName.trim()}>
              Add
            </button>
          </form>
        </div>
        {error && <p className="oa-note bad">{error}</p>}
        <div className="oa-filters">
          <div className="oa-seg" role="group" aria-label="Show">
            {(
              [
                ["all", `All ${items.length}`],
                ["untagged", `Not tagged ${items.length - tagged}`],
                ["active", activePerson ? `${activePerson.name}'s ${countFor(activePerson.id)}` : "Choose a person"],
              ] as const
            ).map(([k, label]) => (
              <button key={k} aria-pressed={filter === k} disabled={k === "active" && !activePerson} onClick={() => setFilter(k)}>
                {label}
              </button>
            ))}
          </div>
          {activePerson && <span className="oa-fine">Tapping tags {activePerson.name}</span>}
        </div>
        <ul className="tg-grid">
          {visible.map((i) => (
            <Tile
              key={items[i].id}
              from={from}
              item={items[i]}
              num={i + 1}
              on={!!active && !!tags.get(i)?.has(active)}
              badges={[...(tags.get(i) || [])].map((id) => people.find((p) => p.id === id)).filter((p): p is Person => !!p)}
              colorOf={colorOf}
              onTap={(shift) => tap(i, shift)}
              refresh={refresh}
            />
          ))}
        </ul>
        {!visible.length && <p className="oa-empty">Nothing here.</p>}
        <div className="oa-actions tg-foot">
          <button className="btn btn-main" disabled={!groups.length} onClick={() => setStage({ k: "where" })}>
            Next: choose where ({groups.length === 1 ? "1 person" : `${groups.length} people`}, {tagged === 1 ? "1 photo" : `${tagged} photos`})
          </button>
          <button className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  /* ------------------------------- Where ------------------------------- */

  if (stage.k === "where") {
    const to = accounts.find((a) => a.e === dest);
    const same = dest === from.e;
    const canAlbums = !!to && !same;
    const needLibrary = albums && canAlbums && !hasScope(dest, LIBRARY_SCOPE);
    const ready = !!to && (folders || (albums && canAlbums)) && !needLibrary;
    return (
      <div>
        <p>
          <b>{tagged === 1 ? "1 photo" : `${tagged} photos`}</b> go into{" "}
          {groups.length === 1 ? `${groups[0].name}'s album or folder` : `an album or folder each for ${groups.length} people`}. Each photo is
          copied once, even if it&rsquo;s in several people&rsquo;s.
        </p>
        <fieldset className="pp-where">
          <legend>Which account gets them?</legend>
          {accounts.map((a, i) => (
            <label key={a.e}>
              <input
                type="radio"
                name="tg-dest"
                checked={dest === a.e}
                onChange={() => {
                  setDest(a.e);
                  if (a.e === from.e) setAlbums(false);
                }}
              />
              <span>
                <b>{a.e}</b> <span className="oa-fine">({i === 0 ? "primary" : "secondary"}{a.e === from.e ? ", where the photos are" : ""})</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="pp-where">
          <legend>As</legend>
          <label className={canAlbums ? "" : "is-off"}>
            <input type="checkbox" checked={albums && canAlbums} disabled={!canAlbums} onChange={(e) => setAlbums(e.target.checked)} />
            <span>
              <b>Google Photos albums</b>, one per person
              {same && (
                <span className="oa-fine">
                  {" "}
                  (not for the account the photos are already in: Google only lets Offload put its own copies in albums, so that would
                  copy every photo into the same library twice)
                </span>
              )}
            </span>
          </label>
          <label>
            <input type="checkbox" checked={folders} onChange={(e) => setFolders(e.target.checked)} />
            <span>
              <b>Google Drive folders</b>, one per person, inside one folder{" "}
              <span className="oa-fine">(easy to share: open a person&rsquo;s folder in Drive and click Share)</span>
            </span>
          </label>
        </fieldset>
        {needLibrary && (
          <p className="oa-note">
            {dest} hasn&rsquo;t let Offload add photos to its Google Photos yet.{" "}
            <button className="btn btn-main" onClick={() => allowScope(dest, LIBRARY_SCOPE).then(() => rerender((n) => n + 1), (e) => setError(String(e?.message || e)))}>
              Allow
            </button>
          </p>
        )}
        {error && <p className="oa-note bad">{error}</p>}
        <label className="pp-parent">
          Name for the folder{albums && canAlbums ? " and the album of everyone" : ""}
          <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
        </label>
        {to && (
          <p className="oa-fine">
            The copies use {dest}&rsquo;s storage{albums && canAlbums && folders ? " (twice: once in Google Photos, once in Drive)" : ""}. The originals stay in{" "}
            {from.e}&rsquo;s Google Photos.
          </p>
        )}
        <div className="oa-actions">
          <button className="btn btn-main" disabled={!ready} onClick={run}>
            {to ? `Sort into ${dest}` : "Choose an account"}
          </button>
          <button className="btn btn-quiet" onClick={() => setStage({ k: "tag" })}>
            Back
          </button>
        </div>
      </div>
    );
  }

  /* ------------------------------ Running ------------------------------ */

  if (stage.k === "running") {
    const pct = Math.round((stage.p.done / Math.max(1, stage.p.total)) * 100);
    return (
      <div>
        <p>{stage.p.message}</p>
        <div className="oa-bar-track" aria-label={`${pct}%`}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <p className="oa-fine">
          {stage.p.done} of {stage.p.total} copies. Keep this tab open until it&rsquo;s done.
        </p>
      </div>
    );
  }

  if (stage.k === "failed") {
    return (
      <div>
        <p className="oa-note bad">{stage.error}</p>
        <div className="oa-actions">
          <button className="btn btn-main" onClick={() => setStage({ k: "where" })}>
            Back
          </button>
          <button className="btn btn-quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  /* -------------------------------- Done ------------------------------- */

  const r = stage.r;
  return (
    <div>
      <p>{r.message}</p>
      {r.results.map((lane) => (
        <div key={lane.into}>
          <p>
            <b>{lane.into === "google_photos" ? "Google Photos albums" : "Google Drive folders"}</b>
            {"parent_folder" in lane && lane.parent_folder && (
              <>
                {" "}
                in{" "}
                <a href={lane.parent_folder} target="_blank" rel="noreferrer">
                  the folder
                </a>
              </>
            )}
            {"all_photos_album" in lane && lane.all_photos_album && (
              <>
                {" "}
                and{" "}
                <a href={lane.all_photos_album} target="_blank" rel="noreferrer">
                  an album of everyone
                </a>
              </>
            )}
          </p>
          <ul className="pp-made">
            {lane.groups.map((g) => {
              const href = ("album" in g && g.album) || ("folder" in g && g.folder) || "";
              return (
                <li key={g.name}>
                  {href ? (
                    <a href={String(href)} target="_blank" rel="noreferrer">
                      {g.name}
                    </a>
                  ) : (
                    g.name
                  )}{" "}
                  <span className="oa-fine">({g.photos === 1 ? "1 photo" : `${g.photos} photos`})</span>
                </li>
              );
            })}
          </ul>
          {lane.copy_problems && lane.copy_problems.length > 0 && (
            <details className="oa-errors">
              <summary>{lane.copy_problems.length === 1 ? "1 problem" : `${lane.copy_problems.length} problems`}</summary>
              <ul>
                {lane.copy_problems.map((p, i) => (
                  <li key={i}>
                    {p.name}: {p.detail}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
      {r.problems && r.problems.length > 0 && (
        <details className="oa-errors">
          <summary>Some photos couldn&rsquo;t be filed</summary>
          <ul>
            {r.problems.map((p, i) => (
              <li key={i}>{p.detail}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="oa-actions">
        <button className="btn btn-main" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

/** One picked photo: a preview loaded when it scrolls into view, the people tagged in it, and a tap to tag. */
function Tile({
  from,
  item,
  num,
  on,
  badges,
  colorOf,
  onTap,
  refresh,
}: {
  from: Account;
  item: Picked;
  num: number;
  on: boolean;
  badges: Person[];
  colorOf: (id: string) => string;
  onTap: (shift: boolean) => void;
  refresh: () => Promise<void>;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  const [seen, setSeen] = useState(false);
  const retried = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!seen || src) return;
    let live = true;
    let made = "";
    queue(() => pickedThumb(from, item.url))
      .then((u) => {
        made = u;
        if (live) setSrc(u);
        else URL.revokeObjectURL(u);
      })
      .catch(async (e: { status?: number }) => {
        if (!live) return;
        if ((e.status === 403 || e.status === 404) && !retried.current) {
          retried.current = true; // the link may have run out: fresh links come back as a new item.url
          await refresh();
          return;
        }
        setFailed(true);
      });
    return () => {
      live = false;
      if (made && !src) URL.revokeObjectURL(made);
    };
  }, [seen, src, from, item.url, refresh]);

  useEffect(() => () => void (src && URL.revokeObjectURL(src)), [src]);

  return (
    <li ref={ref}>
      <button className={`tg-tile${on ? " is-on" : ""}`} aria-pressed={on} aria-label={`${item.name}, photo ${num}${badges.length ? `, tagged ${badges.map((b) => b.name).join(", ")}` : ""}`} onClick={(e) => onTap(e.shiftKey)}>
        {src ? <img src={src} alt="" /> : <span className="tg-ph">{failed ? "No preview" : ""}</span>}
        {item.video && <span className="oa-vid">Video</span>}
        <span className="tg-badges">
          {badges.map((b) => (
            <i key={b.id} style={{ background: colorOf(b.id) }} title={b.name}>
              {initials(b.name)}
            </i>
          ))}
        </span>
      </button>
    </li>
  );
}

/* At most six previews load at once, so a big pick doesn't fire hundreds of requests together. */
let running = 0;
const waiting: (() => void)[] = [];
function queue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const go = () => {
      running++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          running--;
          waiting.shift()?.();
        });
    };
    if (running < 6) go();
    else waiting.push(go);
  });
}
