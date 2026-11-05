"use client";

import { useMemo } from "react";
import { keptRange, NO_CROP, type Crop } from "@/lib/crop";
import { editedStretches, trackLength, type TrackPoint } from "@/lib/track";
import styles from "./Editor.module.css";

interface Props {
  original: TrackPoint[];
  points: TrackPoint[];
  /** The part of the activity that's kept. */
  crop?: Crop;
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
export default function DistanceSummary({ original, points, crop = NO_CROP, before, after, kind, onSelectStretch }: Props) {
  const kept = useMemo(() => keptRange(points, crop), [points, crop]);
  // Edits in a part that's cropped off don't count.
  const stretches = useMemo(
    () => editedStretches(original, points).filter((s) => kept && s.to >= kept[0] && s.from <= kept[1]),
    [original, points, kept],
  );
  // The parts cut off, measured along the track up to the first (from the last) point kept.
  const cuts = useMemo(() => {
    if (!kept) return [];
    const out: { label: string; from: number; to: number; length: number }[] = [];
    if (kept[0] > 0) out.push({ label: "Cut off start", from: 0, to: kept[0], length: trackLength(points.slice(0, kept[0] + 1)) });
    if (kept[1] < points.length - 1)
      out.push({ label: "Cut off end", from: kept[1], to: points.length - 1, length: trackLength(points.slice(kept[1])) });
    return out;
  }, [points, kept]);
  const diff = after - before;
  const what = [
    stretches.length ? (stretches.length === 1 ? "1 edited stretch" : `${stretches.length} edited stretches`) : "",
    cuts.length ? (cuts.length === 1 ? cuts[0].label.toLowerCase() : "cut off start and end") : "",
  ].filter(Boolean);

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
          {what.join(" and ").replace(/^./, (c) => c.toUpperCase())}: see how much each one changed
        </summary>
        <p className={styles.hint}>
          Each stretch runs from the last unchanged point before your edit to the first one after it,
          measured along the GPS track.{cuts.length > 0 && " A cut-off part is measured along the track up to the first (or from the last) point kept."} Click one to select it on the map.
          {kind === "fit" &&
            " The total above is the distance the file stores (which Strava shows), so it can differ a little from the sum of these."}
        </p>
        <ul className={styles.stretchList}>
          {cuts.map((c) => (
            <li key={c.label}>
              <button onClick={() => onSelectStretch(c.from, c.to)} title="Select this part on the map">
                <span className={styles.pointNumber}>
                  {c.from + 1}–{c.to + 1}
                </span>
                <span className={styles.stretchTime}>{formatTime(points[c.from].time)}</span>
                <span>{c.label}</span>
                <span className={styles.tag}>{c.to - c.from} points removed</span>
                <strong className={styles.stretchDiff}>{signedDistance(-c.length)}</strong>
              </button>
            </li>
          ))}
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
