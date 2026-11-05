"use client";

import { isCropped, NO_CROP, type Crop } from "@/lib/crop";
import styles from "./Editor.module.css";

interface Props {
  /** Each point's time (ms), in order; points without a time can't be a start or end. */
  times: (number | null)[];
  crop: Crop;
  onChange: (crop: Crop) => void;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function duration(ms: number): string {
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

/**
 * Two sliders that set where the activity starts and ends. Everything
 * recorded before the start or after the end is cut off when downloading.
 */
export default function CropControls({ times, crop, onChange }: Props) {
  const timed = [...new Set(times.filter((t): t is number => t !== null))].sort((a, b) => a - b);
  if (timed.length < 2) return null;
  const last = timed.length - 1;
  // Slider positions: the first and last moment that's kept.
  const startIdx = crop.start === null ? 0 : Math.max(0, timed.findIndex((t) => t >= crop.start!));
  const endAt = crop.end === null ? -1 : timed.findLastIndex((t) => t <= crop.end!);
  const endIdx = crop.end === null ? last : Math.max(startIdx + 1, endAt);

  const setStart = (i: number) => {
    const k = Math.min(i, endIdx - 1);
    onChange({ ...crop, start: k <= 0 ? null : timed[k] });
  };
  const setEnd = (i: number) => {
    const k = Math.max(i, startIdx + 1);
    onChange({ ...crop, end: k >= last ? null : timed[k] });
  };

  return (
    <section className={styles.crop} aria-label="Crop the activity">
      <strong>Crop</strong>
      <label>
        <span>
          Start <b>{clock(timed[startIdx])}</b>
        </span>
        <input
          type="range"
          min={0}
          max={last}
          value={startIdx}
          onChange={(e) => setStart(Number(e.target.value))}
          aria-label="Start of the activity"
        />
      </label>
      <label>
        <span>
          End <b>{clock(timed[endIdx])}</b>
        </span>
        <input
          type="range"
          min={0}
          max={last}
          value={endIdx}
          onChange={(e) => setEnd(Number(e.target.value))}
          aria-label="End of the activity"
        />
      </label>
      {isCropped(crop) && <button onClick={() => onChange(NO_CROP)}>Don&rsquo;t crop</button>}
      <span className={styles.cropInfo}>
        {isCropped(crop)
          ? `Keeping ${duration(timed[endIdx] - timed[startIdx])} of ${duration(timed[last] - timed[0])}. Everything before the start and after the end is cut off.`
          : "Drag to cut off the start or end, e.g. if you forgot to stop recording."}
      </span>
    </section>
  );
}
