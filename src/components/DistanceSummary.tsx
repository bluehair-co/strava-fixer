"use client";

import { useMemo } from "react";
import { editedStretches, type TrackPoint } from "@/lib/track";
import styles from "./Editor.module.css";

interface Props {
  original: TrackPoint[];
  points: TrackPoint[];
  /** Total distance as the original and the fixed file report it, in metres. */
  before: number;
  after: number;
  /** FIT files store their own distance; GPX distance is measured from the track. */
  kind: "fit" | "gpx";
  onSelectStretch: (from: number, to: number) => void;
}

function km(metres: number): string {
  return `${(metres / 1000).toFixed(2)} km`;
}

/** "+1.23 km", "−45 m", "±0 m": metres under 1 km, km above. */
export function signedDistance(metres: number): string {
  const rounded = Math.round(metres);
  if (rounded === 0) return "±0 m";
  const sign = rounded > 0 ? "+" : "−";
  const abs = Math.abs(rounded);
  return abs < 1000 ? `${sign}${abs} m` : `${sign}${(abs / 1000).toFixed(2)} km`;
}

function percent(before: number, after: number): string {
  if (before <= 0) return "";
  const p = ((after - before) / before) * 100;
  const shown = Math.abs(p) < 0.1 ? p.toFixed(2) : p.toFixed(1);
  return ` (${p > 0 ? "+" : p < 0 ? "−" : ""}${shown.replace("-", "")}%)`;
}

function formatTime(time: number | null): string {
  return time === null ? "" : new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Overview of how your edits changed the total distance, and which edits did it. */
export default function DistanceSummary({ original, points, before, after, kind, onSelectStretch }: Props) {
  const stretches = useMemo(() => editedStretches(original, points), [original, points]);
  const diff = after - before;

  return (
    <section className={styles.distanceSummary} aria-label="Distance change">
      <div className={styles.distanceTotals}>
        <div>
          <span>Original</span>
          <strong>{km(before)}</strong>
        </div>
        <div>
          <span>After your edits</span>
          <strong>{km(after)}</strong>
        </div>
        <div>
          <span>Difference</span>
          <strong className={diff > 0.5 ? styles.longer : diff < -0.5 ? styles.shorter : undefined}>
            {signedDistance(diff)}
            {percent(before, after)}
          </strong>
        </div>
      </div>
      <details>
        <summary>
          {stretches.length === 1 ? "1 edited stretch" : `${stretches.length} edited stretches`}: see how much each one changed
        </summary>
        <p className={styles.hint}>
          Each stretch runs from the last unchanged point before your edit to the first one after it,
          measured along the GPS track. Click one to select it on the map.
          {kind === "fit" &&
            " The total above is the distance the file stores (which Strava shows), so it can differ a little from the sum of these."}
        </p>
        <ul className={styles.stretchList}>
          {stretches.map((s) => (
            <li key={`${s.from}-${s.to}`}>
              <button onClick={() => onSelectStretch(s.from, s.to)} title="Select this stretch on the map">
                <span className={styles.pointNumber}>
                  {s.from + 1}–{s.to + 1}
                </span>
                <span className={styles.stretchTime}>{formatTime(s.time)}</span>
                <span>
                  {Math.round(s.before)} m → {Math.round(s.after)} m
                </span>
                <span className={styles.tag}>
                  {[s.moved && `${s.moved} moved`, s.added && `${s.added} added`].filter(Boolean).join(", ")}
                </span>
                <strong className={styles.stretchDiff}>{signedDistance(s.after - s.before)}</strong>
              </button>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
