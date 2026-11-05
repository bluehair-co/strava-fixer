"use client";

import dynamic from "next/dynamic";
import { useDeferredValue, useMemo, useState } from "react";
import { readActivityFile } from "@/lib/activity";
import { cropFile, inCrop, isCropped, NO_CROP, type Crop } from "@/lib/crop";
import { buildCombined, defaultChoices, planCombine, type Choices, type CombineResult } from "@/lib/combine";
import { CHANNELS, readSource, type Channel, type Source } from "@/lib/sources";
import { trackLength } from "@/lib/track";
import NextSteps from "./NextSteps";
import CropControls from "./CropControls";
import type { MapTrack } from "./TracksMap";
import styles from "./Editor.module.css";

const TracksMap = dynamic(() => import("./TracksMap"), { ssr: false });

/** One colour per file, easy to tell apart on a map (Strava orange is kept for the result). */
const COLORS = ["#1a73e8", "#9334e6", "#188038", "#d01884", "#007b83", "#b06000", "#5f6368", "#c5221f"];
const RESULT_COLOR = "#fc4c02";
const colorOf = (i: number) => COLORS[i % COLORS.length];

const SPORTS = [
  { value: "cycling", label: "Ride" },
  { value: "running", label: "Run" },
  { value: "walking", label: "Walk" },
  { value: "hiking", label: "Hike" },
];

const hhmm = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (t: number) => new Date(t).toLocaleDateString();

/** Splits a list of positions into separate lines wherever there's a long gap. */
function toParts(points: { lat?: number | null; lon?: number | null; time: number | null }[], maxGapMs: number) {
  const parts: [number, number][][] = [];
  let current: [number, number][] = [];
  let lastTime: number | null = null;
  for (const p of points) {
    if (p.lat == null || p.lon == null) continue;
    if (lastTime !== null && p.time !== null && p.time - lastTime > maxGapMs && current.length) {
      parts.push(current);
      current = [];
    }
    current.push([p.lat, p.lon]);
    lastTime = p.time;
  }
  if (current.length) parts.push(current);
  return parts;
}

export default function Merge() {
  const [sources, setSources] = useState<Source[]>([]);
  const [hidden, setHidden] = useState<Set<Source>>(new Set());
  const [showResult, setShowResult] = useState(true);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [showNextSteps, setShowNextSteps] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  // The part of the combined activity to keep.
  const [crop, setCrop] = useState<Crop>(NO_CROP);
  const deferredCrop = useDeferredValue(crop);

  const update = (next: Source[]) => {
    setSources(next);
    setChoices(next.length ? defaultChoices(next) : null);
    setCrop(NO_CROP);
    setShowNextSteps(false);
  };

  const addFiles = async (files: FileList | null | undefined) => {
    if (!files?.length) return;
    const added: Source[] = [];
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      try {
        added.push(readSource(file.name, await readActivityFile(file)));
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (added.length) update([...sources, ...added]);
    setMessage(errors.length ? { kind: "error", text: errors.join(" ") } : null);
  };

  const remove = (i: number) => update(sources.filter((_, j) => j !== i));

  const { result: uncropped, error: combineError } = useMemo((): { result: CombineResult | null; error: string | null } => {
    if (!choices || sources.length === 0) return { result: null, error: null };
    try {
      const plan = planCombine(sources, choices);
      if (plan.rows.length === 0) return { result: null, error: "Choose at least one kind of data to keep." };
      return { result: buildCombined(sources, choices, plan), error: null };
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [sources, choices]);

  // Cropping is done on the combined file, and checked against it.
  const { result, error } = useMemo((): { result: CombineResult | null; error: string | null } => {
    if (!uncropped || !isCropped(deferredCrop) || uncropped.problems.length) return { result: uncropped, error: combineError };
    try {
      const { data, problems } = cropFile(uncropped.data, deferredCrop);
      return {
        result: {
          ...uncropped,
          data,
          problems,
          points: uncropped.points.filter((p) => inCrop(p.time, deferredCrop)),
          summary: `${uncropped.summary} Then the start and end are cropped as you chose.`,
        },
        error: null,
      };
    } catch (err) {
      return { result: null, error: err instanceof Error ? err.message : String(err) };
    }
  }, [uncropped, combineError, deferredCrop]);

  const tracks = useMemo((): MapTrack[] => {
    // The result goes underneath, wide and faint, so the files' own colours show on top of it.
    const list: MapTrack[] = [];
    if (result && showResult) {
      list.push({ parts: toParts(result.points, 60_000), color: RESULT_COLOR, weight: 9, opacity: 0.45, label: "Combined result" });
    }
    const files: MapTrack[] = sources
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !hidden.has(s))
      .map(({ s, i }) => ({
        parts: toParts(s.samples, s.maxGapMs),
        color: colorOf(i),
        weight: 3,
        opacity: 0.75,
        label: s.name,
      }));
    return [...list, ...files];
  }, [sources, hidden, result, showResult]);

  const download = () => {
    if (!result || result.problems.length) return;
    const blob = new Blob([result.data as BlobPart], {
      type: result.kind === "fit" ? "application/octet-stream" : "application/gpx+xml",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = result.fileName;
    a.click();
    URL.revokeObjectURL(url);
    setMessage({
      kind: "info",
      text:
        "Downloaded. The safety check confirmed that every value in it is exactly what one of your files recorded at that moment." +
        (isCropped(crop) ? " Cropping only removed the samples before the start and after the end." : ""),
    });
    setShowNextSteps(true);
  };

  const setPick = (c: Channel, i: number | null) => {
    if (choices) setChoices({ ...choices, pick: { ...choices.pick, [c]: i } });
  };

  // Shared time axis for the coverage bars.
  const t0 = sources.length ? Math.min(...sources.map((s) => s.start)) : 0;
  const t1 = sources.length ? Math.max(...sources.map((s) => s.end)) : 1;
  const bar = (start: number, end: number) => ({
    left: `${((start - t0) / Math.max(1, t1 - t0)) * 100}%`,
    width: `${Math.max(0.5, ((end - start) / Math.max(1, t1 - t0)) * 100)}%`,
  });
  const channelsPresent = CHANNELS.filter((c) => sources.some((s) => s.channels.includes(c.key)));
  const fileSport = sources.find((s) => s.sport)?.sport ?? null;

  return (
    <div className={styles.merge}>
      <label
        className={`${styles.drop} ${styles.dropSmall}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        <strong>{sources.length ? "Add more files" : "Choose the .fit or .gpx files to combine"}</strong>
        <span>or drop them here (you can pick several at once)</span>
        <input type="file" accept=".fit,.gpx,.gz" multiple onChange={(e) => addFiles(e.target.files)} hidden />
      </label>
      {sources.length === 0 && (
        <p className={styles.hint}>
          For example the same ride recorded on your watch and your phone, or two recordings made one after
          the other. Export the original file of each from Strava (open the activity, click the
          &ldquo;&hellip;&rdquo; menu, <em>Export Original</em>). Your files never leave your computer.
        </p>
      )}
      {message && <p className={styles[message.kind]}>{message.text}</p>}

      {sources.length > 0 && choices && (
        <>
          <ul className={styles.fileList}>
            {sources.map((s, i) => (
              <li key={i}>
                <input
                  type="checkbox"
                  title="Show on the map"
                  checked={!hidden.has(s)}
                  onChange={() => {
                    const next = new Set(hidden);
                    if (next.has(s)) next.delete(s);
                    else next.add(s);
                    setHidden(next);
                  }}
                />
                <span className={styles.swatch} style={{ background: colorOf(i) }} />
                <span className={styles.fileName}>{s.name}</span>
                <span className={styles.fileInfo}>
                  {day(s.start)} {hhmm(s.start)}–{hhmm(s.end)} ·{" "}
                  {s.channels.map((c) => CHANNELS.find((x) => x.key === c)!.label).join(", ") || "no data"}
                </span>
                <button className={styles.removeButton} onClick={() => remove(i)} aria-label={`Remove ${s.name}`}>
                  Remove
                </button>
              </li>
            ))}
            {result && (
              <li>
                <input type="checkbox" title="Show on the map" checked={showResult} onChange={() => setShowResult(!showResult)} />
                <span className={styles.swatch} style={{ background: RESULT_COLOR }} />
                <span className={styles.fileName}>Combined result</span>
              </li>
            )}
          </ul>

          <div className={styles.coverage} aria-label="When each file was recording">
            {sources.map((s, i) => (
              <div key={i} className={styles.coverageRow}>
                <span className={styles.coverageBar} style={{ ...bar(s.start, s.end), background: colorOf(i) }} title={s.name} />
              </div>
            ))}
            <div className={styles.coverageAxis}>
              <span>{hhmm(t0)}</span>
              <span>{hhmm(t1)}</span>
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.choiceTable}>
              <thead>
                <tr>
                  <th>Keep…</th>
                  {sources.map((s, i) => (
                    <th key={i} title={s.name}>
                      <span className={styles.swatch} style={{ background: colorOf(i) }} /> {s.name.length > 18 ? `${s.name.slice(0, 16)}…` : s.name}
                    </th>
                  ))}
                  <th>None</th>
                </tr>
              </thead>
              <tbody>
                {channelsPresent.map((c) => (
                  <tr key={c.key}>
                    <td>{c.label}</td>
                    {sources.map((s, i) => (
                      <td key={i}>
                        {s.channels.includes(c.key) ? (
                          <input
                            type="radio"
                            name={`pick-${c.key}`}
                            aria-label={`${c.label} from ${s.name}`}
                            checked={choices.pick[c.key] === i}
                            onChange={() => setPick(c.key, i)}
                          />
                        ) : (
                          <span className={styles.none}>–</span>
                        )}
                      </td>
                    ))}
                    <td>
                      <input
                        type="radio"
                        name={`pick-${c.key}`}
                        aria-label={`No ${c.label.toLowerCase()}`}
                        checked={choices.pick[c.key] == null}
                        onChange={() => setPick(c.key, null)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className={styles.checkRow}>
            <input type="checkbox" checked={choices.fill} onChange={() => setChoices({ ...choices, fill: !choices.fill })} />
            Where the chosen file has no data (for example before it started, or where it lost GPS), use the other files
          </label>
          <label className={styles.checkRow}>
            Sport:{" "}
            <select
              value={choices.sport ?? ""}
              onChange={(e) => setChoices({ ...choices, sport: e.target.value || null })}
            >
              <option value="">From the files{fileSport ? ` (${SPORTS.find((x) => x.value === fileSport)?.label ?? fileSport})` : ""}</option>
              {SPORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <span className={styles.hint}>(only used when a new file is built)</span>
          </label>

          {uncropped && <CropControls times={uncropped.points.map((p) => p.time)} crop={crop} onChange={setCrop} />}
          {error && <p className={styles.error}>{error}</p>}
          {result && result.problems.length > 0 && (
            <p className={styles.error}>
              The safety check failed, so the file can&rsquo;t be downloaded: {result.problems.join(" ")}
            </p>
          )}
          {showNextSteps && <NextSteps merged onClose={() => setShowNextSteps(false)} />}
          {result && (
            <div className={styles.toolbar}>
              <button className={styles.primary} onClick={download} disabled={result.problems.length > 0}>
                Download combined file
              </button>
              <span className={styles.status}>
                {result.summary} Distance {(trackLength(result.points) / 1000).toFixed(2)} km
                {uncropped && result !== uncropped && ` (${(trackLength(uncropped.points) / 1000).toFixed(2)} km before cropping)`}. If a few points are
                still wrong, open the downloaded file in &ldquo;Fix GPS points&rdquo;.
              </span>
            </div>
          )}
          <div className={styles.mergeMap}>
            <TracksMap tracks={tracks} fitKey={sources.map((s) => s.name).join("|")} />
          </div>
        </>
      )}
    </div>
  );
}
