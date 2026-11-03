"use client";

import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { loadActivityBytes, readActivityFile } from "@/lib/activity";
import { joinActivities, joinedFileName } from "@/lib/join";
import { mergeActivities, mergedFileName, type MergeMode } from "@/lib/merge";
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

type How = "combine" | "join";

/** What the page shows and downloads, whichever way the files are put together. */
interface Output {
  kind: "fit" | "gpx";
  data: Uint8Array;
  fileName: string;
  /** Drawn as grey dashes under the result. */
  original: TrackPoint[];
  points: TrackPoint[];
  summary: string;
  problems: string[];
}

export default function Merge() {
  const [how, setHow] = useState<How>("combine");
  const [first, setFirst] = useState<Picked | null>(null);
  const [second, setSecond] = useState<Picked | null>(null);
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

  // Work out the result whenever both files and the options are chosen.
  const { output, error } = useMemo((): { output: Output | null; error: string | null } => {
    if (!first || !second) return { output: null, error: null };
    try {
      if (how === "combine") {
        const r = mergeActivities(second.bytes, first.points, mode);
        return {
          error: null,
          output: {
            ...r,
            fileName: mergedFileName(second.name, r.kind),
            original: first.points,
            summary:
              `${r.changed} of ${r.points.length} samples got a new position` +
              (r.missing > 0 ? ` · ${r.missing} still have none (recording 1 wasn't running then)` : "") +
              ` · distance ${(trackLength(r.points) / 1000).toFixed(2)} km · Grey dashes: recording 1. Orange: the merged track.`,
          },
        };
      }
      const r = joinActivities(first.bytes, second.bytes);
      const firstName = (r.firstIndex === 0 ? first : second).name;
      const gap = r.gapMinutes < 1 ? "less than a minute" : `${Math.round(r.gapMinutes)} min`;
      return {
        error: null,
        output: {
          ...r,
          fileName: joinedFileName(firstName, r.kind),
          original: r.points,
          summary:
            `${firstName} comes first · ${gap} between the two parts (shown as a pause) · ` +
            `distance ${(trackLength(r.points) / 1000).toFixed(2)} km.`,
        },
      };
    } catch (err) {
      return { output: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [first, second, mode, how]);

  const download = () => {
    if (!output || output.problems.length) return;
    const blob = new Blob([output.data as BlobPart], {
      type: output.kind === "fit" ? "application/octet-stream" : "application/gpx+xml",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = output.fileName;
    a.click();
    URL.revokeObjectURL(url);
    setMessage({
      kind: "info",
      text:
        how === "combine"
          ? "Downloaded. The safety check confirmed that the heart rate, cadence, power and every other value from the second file are unchanged; only GPS positions, distance and speed are new."
          : "Downloaded. The safety check confirmed that every sample of both files is in it unchanged; only the second part's running distance was carried on from the first.",
    });
    setShowNextSteps(true);
  };

  const switchTo = (next: How) => {
    setHow(next);
    setMessage(null);
    setShowNextSteps(false);
  };

  return (
    <div className={styles.merge}>
      <fieldset className={styles.options}>
        <legend>What happened?</legend>
        <label>
          <input type="radio" checked={how === "combine"} onChange={() => switchTo("combine")} />{" "}
          <b>Same activity on two devices</b>, at the same time (e.g. phone for GPS, watch for heart rate)
        </label>
        <label>
          <input type="radio" checked={how === "join"} onChange={() => switchTo("join")} />{" "}
          <b>One after the other</b>: one device ran out of battery and I carried on recording with another
        </label>
      </fieldset>
      <p className={styles.hint}>
        Export the original file of both activities from Strava (open each activity, click the
        &ldquo;&hellip;&rdquo; menu, <em>Export Original</em>) and choose them below. Your files never
        leave your computer.
      </p>
      {how === "combine" ? (
        <div className={styles.pickers}>
          <FilePicker
            title="1. Recording with the good GPS"
            help="Usually your phone. Only its GPS track is used."
            picked={first}
            onPick={pick(setFirst)}
          />
          <FilePicker
            title="2. Recording with heart rate, cadence, power…"
            help="Usually your watch. Everything in it is kept: times, laps, heart rate, cadence, power, elevation."
            picked={second}
            onPick={pick(setSecond)}
          />
        </div>
      ) : (
        <div className={styles.pickers}>
          <FilePicker
            title="First recording"
            help="Either order works: the app puts them in time order."
            picked={first}
            onPick={pick(setFirst)}
          />
          <FilePicker
            title="Second recording"
            help="Both need to be the same kind of file (two .fit or two .gpx)."
            picked={second}
            onPick={pick(setSecond)}
          />
        </div>
      )}
      {how === "combine" && (
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
      )}

      {message && <p className={styles[message.kind]}>{message.text}</p>}
      {error && <p className={styles.error}>{error}</p>}
      {output && output.problems.length > 0 && (
        <p className={styles.error}>
          The safety check failed, so the file can&rsquo;t be downloaded: {output.problems.join(" ")}
        </p>
      )}
      {showNextSteps && <NextSteps merged onClose={() => setShowNextSteps(false)} />}

      {output && (
        <>
          <div className={styles.toolbar}>
            <button className={styles.primary} onClick={download} disabled={output.problems.length > 0}>
              {how === "combine" ? "Download merged file" : "Download joined file"}
            </button>
            <span className={styles.status}>
              {output.summary} If a few points are still wrong, open the downloaded file in &ldquo;Fix GPS
              points&rdquo;.
            </span>
          </div>
          <div className={styles.mergeMap}>
            <MapView
              original={output.original}
              points={output.points}
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
