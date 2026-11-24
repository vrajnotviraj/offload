"use client";

import { useEffect, useRef, useState } from "react";
import type { TrashProgress } from "@/lib/gmail/engine";

/**
 * The Gmail cleanup's progress: the matching mail laid out as a grid of envelopes, each standing for a slice of it.
 * As batches land in Trash, envelopes peel off in reading order and arc into a trash can that chomps while it eats,
 * leaving empty slots behind. A rolling odometer counts them in, with the pace and the time left underneath.
 */

const COLS = 16;
const ROWS = 6;
const CELLS = COLS * ROWS;

/** Follows `target` smoothly, so a batch of 1,000 pours in instead of jumping. */
function useEased(target: number) {
  const [v, setV] = useState(target);
  const cur = useRef(target);
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = now - last;
      last = now;
      const diff = target - cur.current;
      if (Math.abs(diff) < 0.5) {
        cur.current = target;
        setV(target);
        return;
      }
      cur.current += diff * Math.min(1, dt / 260);
      setV(cur.current);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

/** A number whose digits roll into place like a mechanical counter. */
function Odometer({ value }: { value: number }) {
  const chars = Math.round(value).toLocaleString("en-US").split("");
  let place = 0;
  const places = chars.map((c) => c).reverse().map((c) => (c >= "0" && c <= "9" ? ++place : 0)).reverse();
  return (
    <span className="tf-odo" aria-hidden="true">
      {chars.map((c, i) => {
        const key = chars.length - i; // keyed from the right, so digits keep their place as the number grows
        if (c < "0" || c > "9") return <span key={key} className="tf-odo-sep">{c}</span>;
        // The last two digits change too fast to roll: they flicker like a slot machine, the rest roll into place.
        return (
          <span key={key} className={`tf-odo-d${places[i] <= 2 ? " is-fast" : ""}`}>
            <span style={{ transform: `translateY(${-Number(c) * 10}%)` }}>
              0<br />1<br />2<br />3<br />4<br />5<br />6<br />7<br />8<br />9
            </span>
          </span>
        );
      })}
    </span>
  );
}

function secs(ms: number) {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : s < 90 ? `${Math.round(s)} s` : `${Math.round(s / 60)} min`;
}

export function TrashFlight({ p, running }: { p: TrashProgress | null; running: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [running]);

  const target = p?.trashed || 0;
  const total = Math.max(p?.total || 0, target);
  const shown = useEased(target);
  const done = !!p?.done;
  const gone = done && target ? CELLS : total ? Math.min(CELLS, Math.floor((shown / total) * CELLS)) : 0;

  // The lid stays open while envelopes are in the air.
  const [eating, setEating] = useState(false);
  useEffect(() => {
    if (!gone) return;
    setEating(true);
    const t = setTimeout(() => setEating(false), 750);
    return () => clearTimeout(t);
  }, [gone]);

  const elapsed = p ? (p.ended || Date.now()) - p.started : 0;
  const rate = elapsed > 600 && target ? target / (elapsed / 1000) : 0;
  const left = rate && p?.totalSure && total > target ? ((total - target) / rate) * 1000 : 0;
  const pct = total ? Math.min(100, Math.round((shown / total) * 100)) : 0;
  const starting = running && !target;

  return (
    <div className={`tf${done ? " is-done" : ""}${starting ? " is-starting" : ""}`}>
      <div className="tf-stage">
        <div className="tf-grid" role="progressbar" aria-label="Emails moved to Trash" aria-valuemin={0} aria-valuemax={total || undefined} aria-valuenow={target}>
          {Array.from({ length: CELLS }, (_, i) => {
            const r = Math.floor(i / COLS);
            const c = i % COLS;
            const style = {
              "--dx": COLS - c + 0.3,
              "--dy": (ROWS - 1) / 2 - r,
              "--wave": `${(c + r) * 40}ms`,
              "--spin": `${((i * 37) % 50) - 25}deg`,
            } as React.CSSProperties;
            return (
              <span key={i} className={`tf-cell${i < gone ? " is-gone" : ""}`} style={style}>
                <i />
              </span>
            );
          })}
        </div>
        <svg className={`tf-can${eating && running ? " is-eating" : ""}`} viewBox="0 0 40 48" aria-hidden="true">
          <g className="tf-lid">
            <rect x="13" y="3" width="14" height="4" rx="2" />
            <rect x="3" y="7" width="34" height="5" rx="2.5" />
          </g>
          <path className="tf-bin" d="M6 15h28l-2.6 28.2A3 3 0 0 1 28.4 46H11.6a3 3 0 0 1-3-2.8Z" />
          <path className="tf-ribs" d="M15 21v18M20 21v18M25 21v18" />
          <path className="tf-check" d="m13 30 5 5 9-10" />
        </svg>
      </div>

      <div className="tf-read">
        <p className="tf-count">
          <Odometer value={done ? target : shown} />
          <span className="tf-of">
            {done ? (target === 1 ? "email in Trash" : "emails in Trash") : total ? `of ${total.toLocaleString("en-US")}${p?.totalSure ? "" : "+"}` : "emails"}
          </span>
          {!done && total > 0 && <span className="tf-pct">{pct}%</span>}
        </p>
        <p className="tf-pace">
          {done
            ? target
              ? `Cleared in ${secs(elapsed)}${rate >= 1 ? ` · ${Math.round(rate).toLocaleString("en-US")} emails a second` : ""}`
              : ""
            : starting
              ? "Warming up…"
              : rate
                ? `${Math.round(rate).toLocaleString("en-US")} emails a second${left ? ` · ${left < 1500 ? "almost done" : `about ${secs(left)} left`}` : ""}`
                : "Picking up speed…"}
        </p>
      </div>
    </div>
  );
}
