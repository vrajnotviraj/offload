"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The "sort photos by person, then share them" story, played out on the home page:
 * 1. Pick: a dozen trip photos get ticked in Google's picker.
 * 2. Sort: each photo flies into the folder of the first person in it; dashed copies are the shortcuts
 *    in everyone else's folder (stored once). The two photos with nobody in them drop out.
 * 3. Share: Riya's and Kabir's folders go to them, found in contacts.
 * It plays on its own while it's on screen; tapping a step takes over. Positions are in cqw (percent of
 * the demo's width), so the whole stage scales as one picture. Under reduced motion it just switches.
 */

type Who = "M" | "R" | "K";
type Stage = 0 | 1 | 2;

const SKIN = "#E5B98F";
const INK = "#1C1B17";
const PEOPLE: Record<Who, { name: string; color: string; body: string; count: number; email?: string; full?: string }> = {
  M: { name: "Me", color: "#FBBC04", body: "#FBBC04", count: 230 },
  R: { name: "Riya", color: "#E0795E", body: "#E0795E", count: 168, full: "Riya Mehta", email: "riya.m@gmail.com" },
  K: { name: "Kabir", color: INK, body: "#46433A", count: 141, full: "Kabir Shah", email: "kabir.s@gmail.com" },
};
const ORDER: Who[] = ["M", "R", "K"];

// Who is in each photo (first named = the folder it's stored in), and which scene it's of.
const TILES: { who: Who[]; scene: number }[] = [
  { who: ["M", "R", "K"], scene: 0 },
  { who: ["R"], scene: 1 },
  { who: ["K"], scene: 2 },
  { who: ["M"], scene: 1 },
  { who: ["M", "R"], scene: 2 },
  { who: [], scene: 3 },
  { who: ["K"], scene: 0 },
  { who: ["R", "K"], scene: 1 },
  { who: ["M"], scene: 0 },
  { who: ["R"], scene: 2 },
  { who: [], scene: 4 },
  { who: ["K", "M"], scene: 1 },
];

const PICK_SIZE = 20;
const SLOT_SIZE = 8;
const FOLDER_X: Record<Who, number> = { M: 2.5, R: 35, K: 67.5 };
const FOLDER_Y = 38;

const pickSpot = (i: number) => ({ x: 4.5 + (i % 4) * 23.5, y: 12 + Math.floor(i / 4) * 21.5 });
const slotSpot = (f: Who, n: number) => ({ x: FOLDER_X[f] + 2.6 + (n % 3) * 8.6, y: FOLDER_Y + 12.5 + Math.floor(n / 3) * 10.5 });

// Where every photo (and every shortcut to it) ends up once sorted.
const SLOTS = (() => {
  const used: Record<Who, number> = { M: 0, R: 0, K: 0 };
  const real: ({ x: number; y: number } | null)[] = [];
  const ghosts: { tile: number; x: number; y: number; n: number }[] = [];
  TILES.forEach((t, i) => {
    real[i] = null;
    t.who.forEach((w, k) => {
      const spot = slotSpot(w, used[w]++);
      if (k === 0) real[i] = spot;
      else ghosts.push({ tile: i, ...spot, n: ghosts.length });
    });
  });
  return { real, ghosts };
})();

function Figure({ x, who }: { x: number; who: Who }) {
  const tall = who === "K";
  const top = tall ? 15 : 19;
  return (
    <g>
      <rect x={x - 4.2} y={top + 4} width="8.4" height={40 - top} rx="3.6" fill={PEOPLE[who].body} />
      <circle cx={x} cy={top} r="3.4" fill={SKIN} />
      {who === "R" ? <path d={`M${x - 3.6} ${top - 0.5}a3.6 3.6 0 0 1 7.2 0v4h-1.6v-3.2h-4v3.2h-1.6Z`} fill={INK} /> : null}
      {who === "K" ? <rect x={x - 2.6} y={top - 1} width="5.2" height="1.6" rx=".8" fill={INK} /> : null}
    </g>
  );
}

function Scene({ scene, who }: { scene: number; who: Who[] }) {
  const sky = ["#FFF1C4", "#F9D7A8", "#FFF8E6", "#FFF1C4", "#F9D7A8"][scene];
  const sea = ["#BFD9D2", "#9FC3BE", "#BFD9D2", "#BFD9D2", "#9FC3BE"][scene];
  const xs = who.length === 1 ? [20] : who.length === 2 ? [14, 26] : [10, 20, 30];
  return (
    <svg viewBox="0 0 40 40" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect width="40" height="40" fill={sky} />
      {scene !== 2 ? (
        <circle
          cx={scene === 1 || scene === 4 ? 9 : 31}
          cy={scene === 1 || scene === 4 ? 21 : 9}
          r="5"
          fill={scene === 1 || scene === 4 ? "#E9A800" : "#FBBC04"}
        />
      ) : null}
      {scene === 2 ? <path d="M5 11a4 4 0 0 1 7-2 3 3 0 0 1 5 2Z M24 8a3.5 3.5 0 0 1 6-1.5 2.6 2.6 0 0 1 4.4 1.5Z" fill="#fff" /> : null}
      <rect y="22" width="40" height="8" fill={sea} />
      <rect y="29" width="40" height="11" fill="#F3DEB4" />
      {scene === 3 ? (
        <g>
          <path d="M26 40c1-9 0-16-3-22" stroke={INK} strokeWidth="2.2" fill="none" strokeLinecap="round" />
          <path
            d="M23 18c-4-3-9-2-11 1 4-1 8-1 11-1Zm0 0c2-4 7-6 11-4-4 0-8 2-11 4Zm0 0c-1-4-5-7-9-6 4 1 7 3 9 6Zm0 0c4-1 8 1 10 5-3-2-7-4-10-5Z"
            fill={INK}
          />
        </g>
      ) : null}
      {scene === 4 ? <path d="M12 26h17l-3 4H15Zm6-1v-9l7 8Z" fill={INK} /> : null}
      {who.map((w, k) => (
        <Figure key={w} x={xs[k]} who={w} />
      ))}
    </svg>
  );
}

function Avatar({ who, size = 22 }: { who: Who; size?: number }) {
  const p = PEOPLE[who];
  return (
    <svg className="sd-av" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill={p.color} />
      <circle cx="12" cy="10" r="4.2" fill={SKIN} />
      <path
        d="M4.5 20.5a7.5 6.5 0 0 1 15 0A11.9 11.9 0 0 1 12 24a11.9 11.9 0 0 1-7.5-3.5Z"
        fill={who === "K" ? "#6E6A5C" : "#fff"}
        opacity={who === "K" ? 1 : 0.9}
      />
    </svg>
  );
}

const STEPS = ["Pick", "Sort", "Share"] as const;
const CAPTIONS = [
  <>
    <b>Pick in Google Photos.</b> Offload only sees the photos you select there.
  </>,
  <>
    <b>Sorted by person.</b> A photo with three of you is stored once: the dashed ones are shortcuts.
  </>,
  <>
    <b>Shared from your contacts,</b> after you say yes. The originals stay in Google Photos for you to delete.
  </>,
];
const STEP_MS = 3800;

export function SortShareDemo() {
  const [stage, setStage] = useState<Stage>(0);
  const [auto, setAuto] = useState(true);
  const [seen, setSeen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setAuto(false);
      return;
    }
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return setSeen(true);
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!auto || !seen) return;
    const t = setTimeout(() => setStage((s) => ((s + 1) % 3) as Stage), STEP_MS + (stage === 2 ? 1200 : 0));
    return () => clearTimeout(t);
  }, [auto, seen, stage]);

  const go = (s: Stage) => {
    setAuto(false);
    setStage(s);
  };

  return (
    <div className="sd-art">
      <span className="sd-polaroid sd-p1" aria-hidden="true">
        <Scene scene={1} who={["M", "R", "K"]} />
        <i>Goa &rsquo;26</i>
      </span>
      <span className="sd-polaroid sd-p2" aria-hidden="true">
        <Scene scene={3} who={[]} />
        <i>sunset</i>
      </span>
      <div className="sdemo" ref={ref} data-stage={stage} aria-label="How sorting and sharing works, in three steps">
        <div className="demo-h">
          <span>Goa trip, sorted &amp; shared</span>
          <span className="demo-hint">{auto ? "Playing. Tap a step" : "Tap a step"}</span>
        </div>
        <div className="sd-tabs" role="group" aria-label="Steps">
          {STEPS.map((label, i) => (
            <button
              key={label}
              type="button"
              className={"sd-tab" + (auto && seen && stage === i ? " is-auto" : "")}
              aria-pressed={stage === i}
              onClick={() => go(i as Stage)}
              style={{ "--step-ms": `${STEP_MS + (i === 2 ? 1200 : 0)}ms` } as React.CSSProperties}
            >
              <span className="sd-n">{i + 1}</span>
              {label}
            </button>
          ))}
        </div>

        <div className="sd-stage" aria-hidden="true">
          {/* 1: Google's picker around the photos */}
          <div className="sd-picker">
            <span className="sd-picker-h">
              <span>
                <b>Google Photos</b> · <b>412</b> selected
              </span>
              <span className="sd-done">Done</span>
            </span>
          </div>

          {/* 2: who's who */}
          <div className="sd-legend">
            <span className="sd-legend-h">You said who&rsquo;s who</span>
            <span className="sd-chips">
              {ORDER.map((w, i) => (
                <span key={w} className="sd-chip" style={{ "--i": i } as React.CSSProperties}>
                  <Avatar who={w} size={18} />
                  {w === "M" ? "Me" : w === "R" ? "Riya, red jacket" : "Kabir, the tall one"}
                </span>
              ))}
            </span>
            <span className="sd-legend-note">2 with nobody in them, left out</span>
          </div>

          {/* 3: who got what */}
          {(["R", "K"] as Who[]).map((w, i) => (
            <div key={w} className="sd-sent" style={{ "--i": i, "--y": 5 + i * 14 } as React.CSSProperties}>
              <Avatar who={w} size={26} />
              <span className="sd-sent-who">
                <b>{PEOPLE[w].full}</b>
                <span>{PEOPLE[w].email}</span>
              </span>
              <span className="sd-sent-ok">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
                Can view · emailed
              </span>
            </div>
          ))}
          {(["R", "K"] as Who[]).map((w, i) => (
            <span
              key={w}
              className="sd-env"
              style={{ "--fx": FOLDER_X[w] + 11, "--fy": FOLDER_Y - 2, "--tx": 4, "--ty": 7 + i * 14, "--i": i } as React.CSSProperties}
            >
              <svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2.5" fill="#fff" />
                <path d="m4 7 8 6 8-6" />
              </svg>
            </span>
          ))}

          {/* the folders */}
          {ORDER.map((w, i) => (
            <div key={w} className={"sd-folder sd-f-" + w} style={{ "--x": FOLDER_X[w], "--i": i } as React.CSSProperties}>
              <span className="sd-folder-h">
                <Avatar who={w} />
                <span className="sd-folder-name">{PEOPLE[w].name}</span>
                <span className="sd-count">{PEOPLE[w].count}</span>
              </span>
              <span className={"sd-badge" + (w === "M" ? " is-mine" : "")}>{w === "M" ? "Yours" : "Shared"}</span>
            </div>
          ))}

          {/* shortcuts: the same photo, shown in the other people's folders */}
          {SLOTS.ghosts.map((g) => (
            <span key={`g${g.n}`} className="sd-ghost" style={{ "--x": g.x, "--y": g.y, "--i": g.n } as React.CSSProperties}>
              <Scene scene={TILES[g.tile].scene} who={TILES[g.tile].who} />
              <svg
                className="sd-link"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M8 16 16 8M10 8h6v6" />
              </svg>
            </span>
          ))}

          {/* the photos themselves */}
          {TILES.map((t, i) => {
            const a = pickSpot(i);
            const b = SLOTS.real[i];
            const sorted = stage > 0;
            const x = sorted ? (b ? b.x : a.x + 3) : a.x;
            const y = sorted ? (b ? b.y : a.y + 4) : a.y;
            const s = sorted ? (b ? SLOT_SIZE / PICK_SIZE : 0.4) : 1;
            return (
              <span
                key={i}
                className={"sd-tile" + (b ? "" : " is-empty")}
                style={{ "--x": x, "--y": y, "--s": s, "--i": i } as React.CSSProperties}
              >
                <Scene scene={t.scene} who={t.who} />
                <span className="sd-tick">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m5 12.5 4.5 4.5L19 7.5" />
                  </svg>
                </span>
              </span>
            );
          })}
        </div>

        <p className="demo-foot sd-foot">{CAPTIONS[stage]}</p>
      </div>
    </div>
  );
}
