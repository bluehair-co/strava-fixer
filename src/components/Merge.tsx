"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { loadActivityBytes, readActivityFile } from "@/lib/activity";
import { mergeActivities, mergedFileName, type MergeMode, type MergeResult } from "@/lib/merge";
import { trackLength, type TrackPoint } from "@/lib/track";
import NextSteps from "./NextSteps";
import styles from "./Editor.module.css";

const MapView = dynamic(() => import("./MapView"), { ssr: false });

interface Picked {
  name: string;
  bytes: Uint8Array;
  points: TrackPoint[];
}

const noop = () => {};

function FilePicker({
  title,
  help,
  picked,
  onPick,
}: {
  title: string;
  help: string;
  picked: Picked | null;
  onPick: (file: File | undefined) => void;
}) {
  return (
    <label
      className={`${styles.drop} ${styles.dropSmall}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onPick(e.dataTransfer.files[0]);
      }}
    >
      <strong>{title}</strong>
      <span className={styles.hint}>{help}</span>
      {picked ? (
        <span className={styles.info}>
          {picked.name} · {picked.points.filter((p) => p.lat !== null).length} GPS points
        </span>
      ) : (
        <span>Choose a .fit or .gpx file, or drop it here</span>
      )}
      <input type="file" accept=".fit,.gpx,.gz" onChange={(e) => onPick(e.target.files?.[0])} hidden />
    </label>
  );
}

export default function Merge() {
  const [gps, setGps] = useState<Picked | null>(null);
  const [sensors, setSensors] = useState<Picked | null>(null);
  const [mode, setMode] = useState<MergeMode>("replace");
  const [showNextSteps, setShowNextSteps] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);

  const pick = (set: (p: Picked) => void) => async (file: File | undefined) => {
    if (!file) return;
    try {
      const bytes = await readActivityFile(file);
      const loaded = await loadActivityBytes(file.name, bytes);
      set({ name: file.name, bytes, points: loaded.points });
      setMessage(null);
      setShowNextSteps(false);
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    }
  };

  // Work out the merge whenever both files and the option are chosen.
  const { result, mergeError } = useMemo((): { result: MergeResult | null; mergeError: string | null } => {
    if (!gps || !sensors) return { result: null, mergeError: null };
    try {
      return { result: mergeActivities(sensors.bytes, gps.points, mode), mergeError: null };
    } catch (err) {
      return { result: null, mergeError: err instanceof Error ? err.message : String(err) };
    }
  }, [gps, sensors, mode]);

  const download = () => {
    if (!result || !sensors) return;
    if (result.problems.length) return;
    const blob = new Blob([result.data as BlobPart], {
      type: result.kind === "fit" ? "application/octet-stream" : "application/gpx+xml",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = mergedFileName(sensors.name, result.kind);
    a.click();
    URL.revokeObjectURL(url);
    setMessage({
      kind: "info",
      text:
        "Downloaded. The safety check confirmed that the heart rate, cadence, power and every other value from the second file are unchanged; only GPS positions, distance and speed are new.",
    });
    setShowNextSteps(true);
  };

  return (
    <div className={styles.merge}>
      <p className={styles.hint}>
        Recorded the same activity on two devices, for example your phone (good GPS) and your watch
        (heart rate, but late or no GPS)? Export the original file of both from Strava (open each
        activity, click the &ldquo;&hellip;&rdquo; menu, <em>Export Original</em>) and choose them
        below. Your files never leave your computer.
      </p>
      <div className={styles.pickers}>
        <FilePicker
          title="1. Recording with the good GPS"
          help="Usually your phone. Only its GPS track is used."
          picked={gps}
          onPick={pick(setGps)}
        />
        <FilePicker
          title="2. Recording with heart rate, cadence, power…"
          help="Usually your watch. Everything in it is kept: times, laps, heart rate, cadence, power, elevation."
          picked={sensors}
          onPick={pick(setSensors)}
        />
      </div>
      <fieldset className={styles.options}>
        <legend>Where should the GPS come from?</legend>
        <label>
          <input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} /> Use recording 1&rsquo;s GPS
          for the whole activity
        </label>
        <label>
          <input type="radio" checked={mode === "fill"} onChange={() => setMode("fill")} /> Keep recording 2&rsquo;s own
          GPS, and only fill in the parts where it had none
        </label>
      </fieldset>

      {message && <p className={styles[message.kind]}>{message.text}</p>}
      {mergeError && <p className={styles.error}>{mergeError}</p>}
      {result && result.problems.length > 0 && (
        <p className={styles.error}>
          The safety check failed, so the merged file can&rsquo;t be downloaded: {result.problems.join(" ")}
        </p>
      )}
      {showNextSteps && <NextSteps merged onClose={() => setShowNextSteps(false)} />}

      {result && gps && (
        <>
          <div className={styles.toolbar}>
            <button className={styles.primary} onClick={download} disabled={result.problems.length > 0}>
              Download merged file
            </button>
            <span className={styles.status}>
              {result.changed} of {result.points.length} samples got a new position
              {result.missing > 0 && ` · ${result.missing} still have none (recording 1 wasn't running then)`}
              {` · distance ${(trackLength(result.points) / 1000).toFixed(2)} km`}
              {" · "}Grey dashes: recording 1. Orange: the merged track. If a few points are still wrong,
              open the merged file in &ldquo;Fix GPS points&rdquo;.
            </span>
          </div>
          <div className={styles.mergeMap}>
            <MapView
              original={gps.points}
              points={result.points}
              selection={null}
              onSelect={noop}
              onBoxSelect={noop}
              onMove={noop}
            />
          </div>
        </>
      )}
    </div>
  );
}
