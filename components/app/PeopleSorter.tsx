"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Account } from "@/lib/drive/api";
import { clusterFaces, groupDistance, loadFaceModels, LOOKS_SIMILAR, photosFor, scanPhoto, type Cluster, type Face, type Photo } from "@/lib/people/faces";
import { fileIntoPeople, type FileProgress, type FileResult } from "@/lib/people/file";

/**
 * Sort by people (web app): the selected Drive photos are scanned for faces in this browser, faces that look alike are
 * grouped, the person names and checks the groups, chooses which account gets the folders, and Offload files them.
 * See lib/people/faces.ts (finding and grouping, all in the browser) and lib/people/file.ts (the folders).
 */

type Group = { id: string; name: string; on: boolean; faces: Face[]; off: Set<string> };
type Stage =
  | { k: "loading" }
  | { k: "scanning"; done: number; total: number }
  | { k: "review" }
  | { k: "where" }
  | { k: "filing"; p: FileProgress }
  | { k: "done"; r: FileResult; to: string }
  | { k: "failed"; error: string };

const MAX_PHOTOS = 500;

export function PeopleSorter({ from, accounts, ids, onClose }: { from: Account; accounts: Account[]; ids: string[]; onClose: () => void }) {
  const [stage, setStage] = useState<Stage>({ k: "loading" });
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [noFaces, setNoFaces] = useState(0);
  const [unread, setUnread] = useState<string[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [dest, setDest] = useState<string>("");
  const [parentName, setParentName] = useState(`People, ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`);
  const stop = useRef(false);

  useEffect(() => {
    stop.current = false;
    (async () => {
      try {
        const [{ photos: ps, skipped: sk }] = await Promise.all([photosFor(from, ids.slice(0, MAX_PHOTOS)), loadFaceModels()]);
        setPhotos(ps);
        setSkipped(sk + Math.max(0, ids.length - MAX_PHOTOS));
        if (!ps.length) return setStage({ k: "failed", error: "None of the selected files are photos. Select some photos (not videos) and try again." });
        setStage({ k: "scanning", done: 0, total: ps.length });
        const faces: Face[] = [];
        const bad: string[] = [];
        let none = 0;
        let done = 0;
        const queue = [...ps];
        // Two at a time: reading is the slow part; the models themselves run one photo at a time on the GPU.
        await Promise.all(
          [0, 1].map(async () => {
            for (let p = queue.shift(); p && !stop.current; p = queue.shift()) {
              const r = await scanPhoto(from, p);
              if (r.error) bad.push(`${p.name}: ${r.error}`);
              else if (!r.faces.length) none++;
              faces.push(...r.faces);
              setStage({ k: "scanning", done: ++done, total: ps.length });
            }
          })
        );
        if (stop.current) return;
        const clusters = clusterFaces(faces);
        setGroups(
          clusters.map((c: Cluster, i) => ({
            id: c.id,
            name: `Person ${i + 1}`,
            on: new Set(c.faces.map((f) => f.photoId)).size >= 2,
            faces: c.faces,
            off: new Set(),
          }))
        );
        setNoFaces(none);
        setUnread(bad);
        setStage({ k: "review" });
      } catch (e) {
        setStage({ k: "failed", error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      stop.current = true;
    };
  }, [from, ids]);

  const name = (id: string) => photos.find((p) => p.id === id)?.name || id;
  const photoIds = (g: Group) => [...new Set(g.faces.filter((f) => !g.off.has(f.key)).map((f) => f.photoId))];
  const chosen = groups.filter((g) => g.on && photoIds(g).length);
  const sorted = useMemo(() => new Set(chosen.flatMap(photoIds)).size, [chosen]); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (id: string, fn: (g: Group) => Group) => setGroups((gs) => gs.map((g) => (g.id === id ? fn(g) : g)));
  const merge = (into: string, other: string) =>
    setGroups((gs) => {
      const a = gs.find((g) => g.id === into)!;
      const b = gs.find((g) => g.id === other)!;
      return gs
        .filter((g) => g.id !== other)
        .map((g) => (g.id === into ? { ...a, on: true, faces: [...a.faces, ...b.faces], off: new Set([...a.off, ...b.off]) } : g));
    });

  const run = async () => {
    const to = accounts.find((a) => a.e === dest);
    if (!to) return;
    setStage({ k: "filing", p: { step: "Starting", done: 0, total: 1 } });
    try {
      const r = await fileIntoPeople(
        from,
        to,
        parentName.trim() || "People",
        chosen.map((g) => ({ name: g.name.trim() || "Unnamed", photoIds: photoIds(g) })),
        (p) => setStage({ k: "filing", p })
      );
      setStage({ k: "done", r, to: to.e });
    } catch (e) {
      setStage({ k: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  };

  if (stage.k === "loading" || stage.k === "scanning") {
    const pct = stage.k === "scanning" ? Math.round((stage.done / Math.max(1, stage.total)) * 100) : 0;
    return (
      <div>
        <p>
          {stage.k === "loading"
            ? "Getting ready: loading the face models (about 12 MB, once) and reading your selection…"
            : `Looking for faces: ${stage.done} of ${stage.total} photos.`}
        </p>
        <div className="oa-bar-track" aria-label={`${pct}% scanned`}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <p className="oa-fine">
          This runs on your device. The photos and faces never leave this browser tab, and nothing is saved: closing this window
          forgets them.
        </p>
        <div className="oa-actions">
          <button className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (stage.k === "failed") {
    return (
      <div>
        <p className="oa-note bad">{stage.error}</p>
        <div className="oa-actions">
          <button className="btn btn-quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  if (stage.k === "review") {
    const row = (g: Group) => {
        const n = photoIds(g).length;
        return (
          <li key={g.id} className={g.on ? "" : "is-off"}>
            <div className="pp-head">
              <input type="checkbox" className="ck" aria-label={`Make a folder for ${g.name}`} checked={g.on} onChange={() => update(g.id, (x) => ({ ...x, on: !x.on }))} />
              <input className="pp-name" value={g.name} maxLength={120} aria-label="Name" onChange={(e) => update(g.id, (x) => ({ ...x, name: e.target.value }))} />
              <span className="pp-count">{n === 1 ? "1 photo" : `${n} photos`}</span>
              {others(g).length > 0 && (
                <select
                  className="pp-merge"
                  value=""
                  aria-label={`Merge another group into ${g.name}`}
                  onChange={(e) => e.target.value && merge(g.id, e.target.value)}
                >
                  <option value="">Merge in…</option>
                  {others(g).map(({ g: o, d }) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                      {d < LOOKS_SIMILAR ? " (looks similar)" : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="pp-faces">
              {g.faces.map((f) => {
                const off = g.off.has(f.key);
                return (
                  <button
                    key={f.key}
                    className={off ? "is-off" : ""}
                    title={`${name(f.photoId)}${off ? " (left out)" : ""}`}
                    aria-pressed={!off}
                    aria-label={`${off ? "Put back" : "Take out"} ${name(f.photoId)}`}
                    onClick={() =>
                      update(g.id, (x) => {
                        const s = new Set(x.off);
                        if (s.has(f.key)) s.delete(f.key);
                        else s.add(f.key);
                        return { ...x, off: s };
                      })
                    }
                  >
                    <img src={f.crop} alt="" />
                  </button>
                );
              })}
            </div>
          </li>
        );
    };
    const many = groups.filter((g) => new Set(g.faces.map((f) => f.photoId)).size >= 2);
    const once = groups.filter((g) => !many.includes(g));
    // Other groups, the most alike first, so a person split in two is quick to put back together.
    const others = (g: Group) =>
      groups
        .filter((x) => x.id !== g.id)
        .map((x) => ({ g: x, d: groupDistance(g.faces, x.faces) }))
        .sort((a, b) => a.d - b.d);
    return (
      <div>
        <p>
          Found <b>{groups.length === 1 ? "1 person" : `${groups.length} people`}</b> in {photos.length === 1 ? "1 photo" : `${photos.length} photos`}.
          Name each one, untick anyone you don&rsquo;t want a folder for, and click a face to take that photo out of a group.
          If one person is split in two, merge them.
        </p>
        <p className="oa-fine">
          Groups are a best guess from how faces look, so check them. Offload doesn&rsquo;t know who anyone is: the names are
          yours.
          {noFaces > 0 && ` ${noFaces} photo${noFaces === 1 ? " had" : "s had"} no faces it could see.`}
          {skipped > 0 && ` ${skipped} selected file${skipped === 1 ? " isn't a photo and was" : "s aren't photos and were"} left out.`}
        </p>
        {unread.length > 0 && (
          <details className="oa-errors">
            <summary>{unread.length === 1 ? "1 photo couldn't be read" : `${unread.length} photos couldn't be read`}</summary>
            <ul>
              {unread.slice(0, 50).map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          </details>
        )}
        {!groups.length && <p className="oa-note">No faces were found in these photos.</p>}
        {many.length > 0 && <ul className="pp-groups">{many.map(row)}</ul>}
        {once.length > 0 && (
          <details className="pp-once" open={!many.length}>
            <summary>
              {once.length === 1 ? "1 face" : `${once.length} faces`} seen in only one photo{" "}
              <span className="oa-fine">(people in the background, mostly; tick anyone who should get a folder)</span>
            </summary>
            <ul className="pp-groups">{once.map(row)}</ul>
          </details>
        )}
        <div className="oa-actions">
          <button className="btn btn-main" disabled={!chosen.length} onClick={() => setStage({ k: "where" })}>
            Next: choose where ({chosen.length === 1 ? "1 folder" : `${chosen.length} folders`})
          </button>
          <button className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (stage.k === "where") {
    const same = dest === from.e;
    return (
      <div>
        <p>
          Which account should get the folders? <b>{sorted === 1 ? "1 photo" : `${sorted} photos`}</b> go into{" "}
          {chosen.length === 1 ? "1 person's folder" : `${chosen.length} people's folders`}, inside one folder.
        </p>
        <fieldset className="pp-where">
          <legend>Put the folders in</legend>
          {accounts.map((a, i) => (
            <label key={a.e}>
              <input type="radio" name="pp-dest" checked={dest === a.e} onChange={() => setDest(a.e)} />
              <span>
                <b>{a.e}</b> <span className="oa-fine">({i === 0 ? "primary" : "secondary"}{a.e === from.e ? ", where the photos are" : ""})</span>
              </span>
            </label>
          ))}
        </fieldset>
        {dest && (
          <p className="oa-fine">
            {same
              ? "Each person's folder gets shortcuts to their photos. Nothing is copied or moved, so it uses no storage."
              : `Each photo is copied into ${dest} once, and also appears (as a shortcut) in every other folder it belongs to. The copies use ${dest}'s storage; the originals stay in ${from.e}.`}
          </p>
        )}
        <label className="pp-parent">
          Folder name
          <input value={parentName} maxLength={200} onChange={(e) => setParentName(e.target.value)} />
        </label>
        <fieldset className="pp-where">
          <legend>As</legend>
          <label>
            <input type="radio" name="pp-kind" checked readOnly />
            <span>
              <b>Google Drive folders</b>, one per person
            </span>
          </label>
          <label className="is-off">
            <input type="radio" name="pp-kind" disabled />
            <span>
              <b>Google Photos albums</b>{" "}
              <span className="oa-fine">
                (not available: Google&rsquo;s rules don&rsquo;t let apps make albums from face groups. You can add a folder&rsquo;s
                photos to an album yourself in Google Photos.)
              </span>
            </span>
          </label>
        </fieldset>
        <div className="oa-actions">
          <button className="btn btn-main" disabled={!dest} onClick={run}>
            {dest ? `Make ${chosen.length === 1 ? "1 folder" : `${chosen.length} folders`} in ${dest}` : "Choose an account"}
          </button>
          <button className="btn btn-quiet" onClick={() => setStage({ k: "review" })}>
            Back
          </button>
        </div>
      </div>
    );
  }

  if (stage.k === "filing") {
    const pct = Math.round((stage.p.done / Math.max(1, stage.p.total)) * 100);
    return (
      <div>
        <p>
          {stage.p.step}: {stage.p.done} of {stage.p.total}
        </p>
        <div className="oa-bar-track" aria-label={`${pct}%`}>
          <i style={{ width: `${pct}%` }} />
        </div>
        <p className="oa-fine">Keep this tab open until it&rsquo;s done.</p>
      </div>
    );
  }

  const r = stage.r;
  return (
    <div>
      <p>
        Made <b>{r.folders.length === 1 ? "1 person's folder" : `${r.folders.length} people's folders`}</b> inside{" "}
        <a href={r.parent.link} target="_blank" rel="noreferrer">
          {r.parent.name}
        </a>{" "}
        in {stage.to}
        {r.copied > 0 ? `, with ${r.copied} photo${r.copied === 1 ? "" : "s"} copied there` : ""}.
      </p>
      <ul className="pp-made">
        {r.folders.map((f) => (
          <li key={f.id}>
            <a href={f.link} target="_blank" rel="noreferrer">
              {f.name}
            </a>{" "}
            <span className="oa-fine">({f.photos === 1 ? "1 photo" : `${f.photos} photos`})</span>
          </li>
        ))}
      </ul>
      {r.problems.length > 0 && (
        <details className="oa-errors">
          <summary>{r.problems.length === 1 ? "1 photo had a problem" : `${r.problems.length} photos had problems`}</summary>
          <ul>
            {r.problems.slice(0, 50).map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="oa-fine">To share a person&rsquo;s photos with them, open their folder in Drive and click Share.</p>
      <div className="oa-actions">
        <button className="btn btn-main" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
