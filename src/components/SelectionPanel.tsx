"use client";

import { originalsOf, type TrackPoint } from "@/lib/track";
import styles from "./Editor.module.css";

interface Props {
  points: TrackPoint[];
  original: TrackPoint[];
  from: number;
  to: number;
  canRemoveGps: boolean;
  /** Recorded points are locked: only added points can be changed. */
  locked: boolean;
  onExtend: (side: "before" | "after") => void;
  onStraighten: () => void;
  onRemoveGps: () => void;
  onDeleteAdded: () => void;
  onClear: () => void;
}

function formatTime(time: number | null): string {
  return time === null ? "no time" : new Date(time).toLocaleTimeString();
}

/** Side panel listing the selected points, with tools that act on them. */
export default function SelectionPanel({
  points,
  original,
  from,
  to,
  canRemoveGps,
  locked,
  onExtend,
  onStraighten,
  onRemoveGps,
  onDeleteAdded,
  onClear,
}: Props) {
  const count = to - from + 1;
  const originals = originalsOf(original, points);
  let addedCount = 0;
  const rows = [];
  for (let i = from; i <= to; i++) {
    const p = points[i];
    const o = originals[i];
    if (!o) addedCount++;
    const moved = o !== null && (p.lat !== o.lat || p.lon !== o.lon);
    rows.push(
      <li key={i}>
        <span className={styles.pointNumber}>{i + 1}</span>
        <span>{formatTime(p.time)}</span>
        {!o ? (
          <span className={styles.tag}>added</span>
        ) : p.lat === null ? (
          <span className={styles.tag}>no GPS</span>
        ) : moved ? (
          <span className={styles.tag}>moved</span>
        ) : null}
      </li>,
    );
  }

  return (
    <aside className={styles.panel} aria-label="Selected points">
      <div className={styles.panelHeader}>
        <strong>
          {count === 1 ? `${originals[from] ? "Point" : "Added point"} ${from + 1}` : `Points ${from + 1}–${to + 1}`}
        </strong>
        <span>
          {count} {count === 1 ? "point" : "points"} selected
        </span>
      </div>

      <div className={styles.panelButtons}>
        <button onClick={() => onExtend("before")} disabled={from === 0} title="Add the point just before the selection">
          + Point before
        </button>
        <button onClick={() => onExtend("after")} disabled={to === points.length - 1} title="Add the point just after the selection">
          + Point after
        </button>
      </div>

      <div className={styles.panelButtons}>
        <button onClick={onStraighten} disabled={count < 3} title={
            locked
              ? "Line up the added points between the first and last selected point (recorded points are locked)"
              : "Line up the points between the first and last selected point"
          }>
          Straighten
        </button>
        {canRemoveGps && !locked && (
          <button onClick={onRemoveGps} title="Keep the samples (heart rate etc.) but drop their GPS position. Added points are deleted.">
            Remove GPS
          </button>
        )}
        {addedCount > 0 && (
          <button onClick={onDeleteAdded} title="Delete the points you added (recorded points stay)">
            Delete added {addedCount === 1 ? "point" : "points"}
          </button>
        )}
        <button onClick={onClear}>Clear selection</button>
      </div>
      {count < 3 && (
        <p className={styles.hint}>
          Straighten needs at least 3 points: the two ends stay put and the ones in between are lined up.
        </p>
      )}

      <ol className={styles.pointList}>{rows}</ol>
    </aside>
  );
}
