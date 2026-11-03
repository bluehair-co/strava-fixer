"use client";

import dynamic from "next/dynamic";
import { useCallback, useMemo, useState } from "react";
import { fixedFileName, loadActivity, type LoadedActivity } from "@/lib/activity";
import { clearPositions, countChanged, movePoint, straighten, type TrackPoint } from "@/lib/track";
import type { Selection } from "./MapView";
import styles from "./Editor.module.css";

// Leaflet needs the browser, so the map is only loaded on the client.
const MapView = dynamic(() => import("./MapView"), { ssr: false });

function formatKm(metres: number): string {
  return `${(metres / 1000).toFixed(2)} km`;
}

export default function Editor() {
  const [activity, setActivity] = useState<LoadedActivity | null>(null);
  const [history, setHistory] = useState<TrackPoint[][]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  const points = history[history.length - 1];

  const distances = useMemo(() => {
    if (!activity || !points) return null;
    return { before: activity.distance(activity.points), after: activity.distance(points) };
  }, [activity, points]);

  const openFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const loaded = await loadActivity(file);
      setActivity(loaded);
      setHistory([loaded.points]);
      setSelection(null);
      setMessage(null);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };

  const apply = useCallback((next: TrackPoint[]) => setHistory((h) => [...h, next]), []);

  const onSelect = useCallback((index: number, extend: boolean) => {
    setSelection((sel) => (extend && sel ? { from: sel.from, to: index } : { from: index, to: index }));
  }, []);

  const onMove = useCallback(
    (index: number, lat: number, lon: number) => {
      setHistory((h) => [...h, movePoint(h[h.length - 1], index, lat, lon)]);
    },
    [],
  );

  const isRange = selection !== null && selection.from !== selection.to;

  const doStraighten = () => {
    if (!selection) return;
    try {
      apply(straighten(points, selection.from, selection.to));
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

  const download = () => {
    if (!activity) return;
    const { data, problems } = activity.build(points);
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
    a.download = fixedFileName(activity.fileName, activity.kind);
    a.click();
    URL.revokeObjectURL(url);
    setMessage({
      kind: "info",
      text:
        "Downloaded. The safety check confirmed that only GPS positions, and the distance and speed calculated from them, changed.",
    });
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

  const changed = countChanged(activity.points, points);

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <span className={styles.file}>{activity.fileName}</span>
        <button onClick={doStraighten} disabled={!isRange} title="Line up the points between the two ends of the selection">
          Straighten selection
        </button>
        {activity.kind === "fit" && (
          <button onClick={doRemove} disabled={!selection} title="Keep the samples (heart rate etc.) but drop their GPS position">
            Remove GPS from selection
          </button>
        )}
        <button onClick={() => setHistory((h) => h.slice(0, -1))} disabled={history.length < 2}>
          Undo
        </button>
        <button onClick={() => { setHistory([activity.points]); setSelection(null); }} disabled={history.length < 2}>
          Reset
        </button>
        <button className={styles.primary} onClick={download} disabled={changed === 0}>
          Download fixed file
        </button>
        <button onClick={() => { setActivity(null); setHistory([]); setMessage(null); }}>Open another file</button>
      </div>
      <p className={styles.status}>
        {points.length} points · {changed} changed
        {distances?.before != null && distances.after != null &&
          ` · distance ${formatKm(distances.before)}${changed ? ` → ${formatKm(distances.after)}` : ""}`}
        {selection &&
          ` · selected ${isRange ? `points ${Math.min(selection.from, selection.to) + 1}–${Math.max(selection.from, selection.to) + 1}` : `point ${selection.from + 1}`}`}
        {" · "}Click a point to select it, shift-click another to select a range, drag a point to move it.
      </p>
      {message && <p className={styles[message.kind]}>{message.text}</p>}
      <div className={styles.map}>
        <MapView
          original={activity.points}
          points={points}
          selection={selection}
          onSelect={onSelect}
          onMove={onMove}
        />
      </div>
    </div>
  );
}
