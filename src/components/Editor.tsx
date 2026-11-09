"use client";

import dynamic from "next/dynamic";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { fixedFileName, loadActivity, loadActivityBytes, type LoadedActivity } from "@/lib/activity";
import { isCropped, keptRange, NO_CROP, type Crop } from "@/lib/crop";
import {
  clearPositions,
  countChanged,
  deleteAdded,
  insertPoint,
  movePoint,
  retime,
  straighten,
  type TrackPoint,
} from "@/lib/track";
import type { Selection } from "./MapView";
import SelectionPanel from "./SelectionPanel";
import NextSteps from "./NextSteps";
import DistanceSummary from "./DistanceSummary";
import CropControls from "./CropControls";
import styles from "./Editor.module.css";

// Leaflet needs the browser, so the map is only loaded on the client.
const MapView = dynamic(() => import("./MapView"), { ssr: false });

function formatKm(metres: number): string {
  return `${(metres / 1000).toFixed(2)} km`;
}

/** A file handed over from another tab (a new `id` each time it's sent). */
export interface IncomingFile {
  fileName: string;
  data: Uint8Array;
  id: number;
}

export default function Editor({ incoming = null }: { incoming?: IncomingFile | null }) {
  const [activity, setActivity] = useState<LoadedActivity | null>(null);
  // True when the open file was made in "Combine recordings" (it isn't on Strava yet).
  const [fromCombine, setFromCombine] = useState(false);
  const [history, setHistory] = useState<TrackPoint[][]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [showNextSteps, setShowNextSteps] = useState(false);
  const [addMode, setAddMode] = useState(false);
  // Locked: recorded points can't be moved by mistake; added points still can.
  const [locked, setLocked] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  // The part of the activity to keep (everything else is cut off when downloading).
  const [crop, setCrop] = useState<Crop>(NO_CROP);
  // Recalculating the distance can take a moment; let the sliders move first.
  const deferredCrop = useDeferredValue(crop);

  const points = history[history.length - 1];

  const distances = useMemo(() => {
    if (!activity || !points) return null;
    try {
      return { before: activity.distance(activity.points), after: activity.distance(points, deferredCrop) };
    } catch {
      return null;
    }
  }, [activity, points, deferredCrop]);

  const show = (loaded: LoadedActivity, combined: boolean) => {
    setActivity(loaded);
    setFromCombine(combined);
    setHistory([loaded.points]);
    setSelection(null);
    setCrop(NO_CROP);
    setShowNextSteps(false);
    setMessage(
      combined
        ? {
            kind: "info",
            text: "This is your combined file, which already passed its safety check. Fix any GPS points you need, then download it.",
          }
        : null,
    );
  };

  const openFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      show(await loadActivity(file), false);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };

  // A combined file sent over from "Combine recordings" replaces whatever is open.
  useEffect(() => {
    if (!incoming) return;
    let cancelled = false;
    Promise.resolve(loadActivityBytes(incoming.fileName, incoming.data))
      .then((loaded) => !cancelled && show(loaded, true))
      .catch((err) => !cancelled && setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [incoming]);

  // Every edit also updates the times of added points (see `retime`).
  const apply = useCallback((next: TrackPoint[]) => setHistory((h) => [...h, retime(next)]), []);

  const onSelect = useCallback((index: number, extend: boolean) => {
    setSelection((sel) => (extend && sel ? { from: sel.from, to: index } : { from: index, to: index }));
  }, []);

  const onMove = useCallback(
    (index: number, lat: number, lon: number) => {
      setHistory((h) => [...h, movePoint(h[h.length - 1], index, lat, lon)]);
    },
    [],
  );

  const onBoxSelect = useCallback((from: number, to: number) => setSelection({ from, to }), []);

  const onInsert = useCallback(
    (after: number, lat: number, lon: number) => {
      const next = insertPoint(points, after, lat, lon);
      const added = next[after + 1];
      if (added.time === null && points.some((p) => p.time !== null)) {
        setMessage({
          kind: "error",
          text: "A point can't be added here: one of the points on either side has no time, so there's no time to give the new point.",
        });
        return;
      }
      setHistory((h) => [...h, next]);
      setSelection({ from: after + 1, to: after + 1 });
      setMessage(null);
    },
    [points],
  );

  // The selection as first and last index, whichever way it was made.
  const lo = selection ? Math.min(selection.from, selection.to) : -1;
  const hi = selection ? Math.max(selection.from, selection.to) : -1;

  const extendSelection = (side: "before" | "after") => {
    if (!selection) return;
    setSelection(
      side === "before"
        ? { from: Math.max(0, lo - 1), to: hi }
        : { from: lo, to: Math.min(points.length - 1, hi + 1) },
    );
  };

  const doStraighten = () => {
    if (!selection) return;
    try {
      apply(straighten(points, selection.from, selection.to, locked));
      setMessage(null);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const doRemove = () => {
    if (!selection) return;
    apply(clearPositions(points, selection.from, selection.to));
    setSelection(null);
  };

  const doDeleteAdded = () => {
    if (!selection) return;
    apply(deleteAdded(points, selection.from, selection.to));
    setSelection(null);
  };

  // Crop at the selected points: start at the first one, or end at the last one.
  const cropAt = (side: "start" | "end") => {
    const time = points[side === "start" ? lo : hi]?.time ?? null;
    if (time === null) return;
    const next = { ...crop, [side]: time };
    if (next.start !== null && next.end !== null && next.end <= next.start) {
      setMessage({ kind: "error", text: "The end of the activity has to come after its start." });
      return;
    }
    setCrop(next);
    setSelection(null);
    setMessage(null);
  };

  const download = () => {
    if (!activity) return;
    let built: { data: Uint8Array; problems: string[] };
    try {
      built = activity.build(points, crop);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
      return;
    }
    const { data, problems } = built;
    if (problems.length) {
      setMessage({
        kind: "error",
        text: `The safety check failed, so nothing was downloaded: ${problems.join(" ")}`,
      });
      return;
    }
    const blob = new Blob([data as BlobPart], {
      type: activity.kind === "fit" ? "application/octet-stream" : "application/gpx+xml",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fromCombine && points === activity.points && !isCropped(crop) ? activity.fileName : fixedFileName(activity.fileName, activity.kind);
    a.click();
    URL.revokeObjectURL(url);
    setMessage({
      kind: "info",
      text:
        (points.some((p) => p.added)
          ? "Downloaded. The safety check confirmed that only GPS positions, and the distance and speed calculated from them, changed, and that the points you added hold only a time and a position."
          : "Downloaded. The safety check confirmed that only GPS positions, and the distance and speed calculated from them, changed.") +
        (isCropped(crop)
          ? " It also confirmed that cropping only removed the samples before the start and after the end, and that the samples kept are as they were apart from their distance."
          : ""),
    });
    setShowNextSteps(true);
  };

  if (!activity || !points) {
    return (
      <div className={styles.start}>
        <label
          className={styles.drop}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            openFile(e.dataTransfer.files[0]);
          }}
        >
          <strong>Choose a .fit or .gpx file</strong>
          <span>or drop it here</span>
          <input
            type="file"
            accept=".fit,.gpx,.gz"
            onChange={(e) => openFile(e.target.files?.[0])}
            hidden
          />
        </label>
        <p className={styles.hint}>
          To get the original file from Strava, open the activity, click the
          &ldquo;&hellip;&rdquo; menu and choose <em>Export Original</em>. Your
          file never leaves your computer.
        </p>
        {message && <p className={styles[message.kind]}>{message.text}</p>}
      </div>
    );
  }

  const { moved, added } = countChanged(activity.points, points);
  const cropped = isCropped(crop);
  const changed = moved + added + (cropped ? 1 : 0);
  const kept = keptRange(points, crop);

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <span className={styles.file}>{activity.fileName}</span>
        <button onClick={() => setHistory((h) => h.slice(0, -1))} disabled={history.length < 2}>
          Undo
        </button>
        <button onClick={() => { setHistory([activity.points]); setSelection(null); setCrop(NO_CROP); }} disabled={history.length < 2 && !cropped}>
          Reset
        </button>
        <button
          onClick={() => setAddMode((on) => !on)}
          aria-pressed={addMode}
          className={addMode ? styles.active : undefined}
          title="Click on the map to add new points between existing ones"
        >
          {addMode ? "Done adding points" : "Add points"}
        </button>
        <button
          onClick={() => setLocked((on) => !on)}
          aria-pressed={locked}
          className={locked ? styles.active : undefined}
          title={
            locked
              ? "Recorded points are frozen. Click to allow moving them again."
              : "Freeze the recorded points so they can't be moved by mistake. Points you add can still be moved."
          }
        >
          {locked ? "🔒 Recorded points locked" : "🔓 Lock recorded points"}
        </button>
        <button className={styles.primary} onClick={download} disabled={changed === 0 && !fromCombine}>
          {fromCombine ? "Download combined file" : "Download fixed file"}
        </button>
        <button onClick={() => { setActivity(null); setFromCombine(false); setHistory([]); setMessage(null); setShowNextSteps(false); setAddMode(false); setLocked(false); setCrop(NO_CROP); }}>Open another file</button>
      </div>
      <p className={styles.status}>
        {points.length} points · {moved} changed{added > 0 && ` · ${added} added`}
        {cropped && kept && ` · keeping points ${kept[0] + 1}–${kept[1] + 1}`}
        {distances?.before != null && distances.after != null &&
          !changed && ` · distance ${formatKm(distances.before)}`}
        {" · "}
        {addMode
          ? "Click on the map to add a point to the nearest stretch of track. Its time is worked out from how far along the stretch it is. Drag points to move them."
          : "Click a point to select it. Shift-click another point, or hold Shift and drag a box, to select a range. Drag a point to move it."}
        {locked && " Recorded points are locked: only points you added can be moved."}
      </p>
      {message && <p className={styles[message.kind]}>{message.text}</p>}
      <CropControls times={points.map((p) => p.time)} crop={crop} onChange={setCrop} />
      {changed > 0 && distances?.before != null && distances.after != null && (
        <DistanceSummary
          original={activity.points}
          points={points}
          crop={deferredCrop}
          before={distances.before}
          after={distances.after}
          kind={activity.kind}
          onSelectStretch={(from, to) => setSelection({ from, to })}
        />
      )}
      {showNextSteps && <NextSteps merged={fromCombine} onClose={() => setShowNextSteps(false)} />}
      <div className={styles.workspace}>
        <div className={styles.map}>
          <MapView
            original={activity.points}
            points={points}
            selection={selection}
            crop={crop}
            onSelect={onSelect}
            onBoxSelect={onBoxSelect}
            onMove={onMove}
            addMode={addMode}
            locked={locked}
            onInsert={onInsert}
          />
        </div>
        {selection && (
          <SelectionPanel
            points={points}
            original={activity.points}
            from={lo}
            to={hi}
            canRemoveGps={activity.kind === "fit"}
            locked={locked}
            onExtend={extendSelection}
            onStraighten={doStraighten}
            onRemoveGps={doRemove}
            onDeleteAdded={doDeleteAdded}
            onCrop={cropAt}
            onClear={() => setSelection(null)}
          />
        )}
      </div>
    </div>
  );
}
