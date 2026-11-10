"use client";

import { useDeferredValue, useMemo, useState } from "react";
import type { Crop } from "@/lib/crop";
import { DEFAULT_TIDY, findStops, type TidySettings } from "@/lib/stops";
import type { TrackPoint } from "@/lib/track";
import styles from "./Editor.module.css";

interface Props {
  points: TrackPoint[];
  crop: Crop;
  /** Recorded points are locked, so stops can't be straightened. */
  locked: boolean;
  onStraighten: (settings: TidySettings) => void;
  onCrop: (crop: Crop) => void;
  onSelect: (from: number, to: number) => void;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  return s % 60 ? `${min} min ${s % 60} s` : `${min} min`;
}

const sameCrop = (a: Crop, b: Crop) => a.start === b.start && a.end === b.end;

/**
 * Finds the stops (where the GPS wandered around while you stood still) and
 * the time spent standing still at the start and end, with sliders to tune
 * what counts as standing still. One click straightens the stops or crops
 * the idle time off.
 */
export default function AutoTidy({ points, crop, locked, onStraighten, onCrop, onSelect }: Props) {
  const [settings, setSettings] = useState<TidySettings>(DEFAULT_TIDY);
  // Finding stops takes a moment on long activities; let the sliders move first.
  const deferred = useDeferredValue(settings);
  const found = useMemo(() => findStops(points, deferred), [points, deferred]);
  const todo = found.stops.filter((s) => !s.straightened);
  const wander = todo.reduce((sum, s) => sum + s.wander - s.straight, 0);
  const canCrop = (found.crop.start !== null || found.crop.end !== null) && !sameCrop(found.crop, crop);
  const set = (key: keyof TidySettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setSettings((s) => ({ ...s, [key]: Number(e.target.value) }));

  const summary = [
    found.stops.length === 1 ? "1 stop" : `${found.stops.length} stops`,
    found.idleStart !== null && "idle start",
    found.idleEnd !== null && "idle end",
  ].filter(Boolean);

  return (
    <section className={styles.tidy} aria-label="Tidy up automatically">
      <details>
        <summary>
          <strong>Tidy up automatically</strong>
          <span className={styles.cropInfo}>
            {" "}
            · found {summary.join(", ")}
            {todo.length > 0 && wander >= 1 && ` · straightening would remove ${Math.round(wander)} m of GPS wander`}
          </span>
        </summary>
        <p className={styles.hint}>
          When you stand still, GPS keeps wandering around and adds distance you never rode. This finds those moments
          from the GPS positions and their times. Straightening a stop moves its points onto a straight line from where
          the stop began to where it ended; cropping cuts off the standing still before you set off and after you
          arrived. Nothing else in the file changes. Tune the sliders if it finds too much or too little.
        </p>
        <div className={styles.tidySliders}>
          <label>
            <span>
              Standing still: within <b>{settings.radius} m</b>
            </span>
            <input type="range" min={10} max={80} step={5} value={settings.radius} onChange={set("radius")} />
          </label>
          <label>
            <span>
              Shortest stop: <b>{duration(settings.minStopSeconds * 1000)}</b>
            </span>
            <input
              type="range"
              min={20}
              max={600}
              step={10}
              value={settings.minStopSeconds}
              onChange={set("minStopSeconds")}
            />
          </label>
          <label>
            <span>
              Keep <b>{settings.keepSeconds} s</b> before setting off and after arriving
            </span>
            <input type="range" min={0} max={60} step={1} value={settings.keepSeconds} onChange={set("keepSeconds")} />
          </label>
          <button onClick={() => setSettings(DEFAULT_TIDY)} disabled={settings === DEFAULT_TIDY}>
            Default settings
          </button>
        </div>

        <ul className={styles.stretchList}>
          {found.idleStart !== null && (
            <li>
              <button onClick={() => onSelect(0, found.idleStart!)} title="Select this part on the map">
                <span className={styles.stretchTime}>Start</span>
                <span>
                  Standing still until {clock(points[found.idleStart].time!)}
                  {found.crop.start !== null && ` · crop to start at ${clock(found.crop.start)}`}
                </span>
              </button>
            </li>
          )}
          {found.stops.map((s) => (
            <li key={`${s.from}-${s.to}`}>
              <button onClick={() => onSelect(s.from, s.to)} title="Select this stop on the map">
                <span className={styles.stretchTime}>{clock(s.start)}</span>
                <span>Stopped {duration(s.end - s.start)}</span>
                {s.straightened ? (
                  <span className={styles.tag}>already straight</span>
                ) : (
                  <span>
                    GPS wandered {Math.round(s.wander)} m, start to end is {Math.round(s.straight)} m
                  </span>
                )}
              </button>
            </li>
          ))}
          {found.idleEnd !== null && (
            <li>
              <button onClick={() => onSelect(found.idleEnd!, points.length - 1)} title="Select this part on the map">
                <span className={styles.stretchTime}>End</span>
                <span>
                  Standing still from {clock(points[found.idleEnd].time!)}
                  {found.crop.end !== null && ` · crop to end at ${clock(found.crop.end)}`}
                </span>
              </button>
            </li>
          )}
          {found.stops.length === 0 && found.idleStart === null && found.idleEnd === null && (
            <li className={styles.cropInfo}>Nothing found with these settings.</li>
          )}
        </ul>

        <div className={styles.panelButtons}>
          <button
            onClick={() => onStraighten(settings)}
            disabled={todo.length === 0 || locked}
            title={locked ? "Unlock the recorded points first" : undefined}
          >
            Straighten {todo.length === 1 ? "1 stop" : `${todo.length} stops`}
          </button>
          <button onClick={() => onCrop(found.crop)} disabled={!canCrop}>
            Crop to when you were moving
          </button>
          <button
            onClick={() => {
              if (todo.length && !locked) onStraighten(settings);
              if (canCrop) onCrop(found.crop);
            }}
            disabled={!((todo.length && !locked) || canCrop)}
          >
            Do both
          </button>
        </div>
        {locked && todo.length > 0 && (
          <p className={styles.cropInfo}>Recorded points are locked, so stops can&rsquo;t be straightened.</p>
        )}
      </details>
    </section>
  );
}
