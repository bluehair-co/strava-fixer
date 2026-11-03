/**
 * Works out the new cumulative distance after GPS points have been fixed.
 *
 * Watches and apps store a running distance that doesn't always come from
 * raw GPS (it may be smoothed, or come from a wheel sensor). So we only
 * replace it where you edited the track:
 *
 *  - The track is split at "anchor" points: points with a position that you
 *    didn't change. A stretch between two anchors that contains any edited
 *    point is an edited window.
 *  - Inside a window, distance = the distance at the window's start + the
 *    length of the fixed track travelled so far (interpolated by time).
 *  - Outside windows the recorded distance is kept, shifted by however much
 *    the earlier windows grew or shrank.
 *
 * The result never goes backwards.
 */

import { metresBetween, type TrackPoint } from "./track";

interface Window {
  start: number; // time (s) of the anchor before, or -Infinity
  end: number; // time (s) of the anchor after, or +Infinity
  base: number; // new distance at `start`
  /** Fixed-track distance from the window start (gs), at each point time (ts). */
  ts: number[];
  gs: number[];
}

/** Linear interpolation of y at x over points sorted by x (clamped at the ends). */
function interpolate(xs: number[], ys: number[], x: number): number {
  if (xs.length === 0) return 0;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xs[hi] - xs[lo];
  return span === 0 ? ys[hi] : ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / span;
}

export interface DistanceModel {
  /** Recorded distance (m) at time t (s), interpolated. */
  originalAt(t: number): number;
  /** Corrected distance (m) at time t (s). */
  fixedAt(t: number): number;
}

/**
 * @param original  points as recorded
 * @param fixed     points after editing (same length)
 * @param times     each point's time in seconds (same clock as `recorded`)
 * @param recorded  the file's own distance samples, sorted by time
 */
export function buildDistanceModel(
  original: TrackPoint[],
  fixed: TrackPoint[],
  times: (number | null)[],
  recorded: { t: number; d: number }[],
): DistanceModel {
  const recT = recorded.map((r) => r.t);
  const recD = recorded.map((r) => r.d);
  const originalAt = (t: number) => interpolate(recT, recD, t);

  const changed = fixed.map((p, i) => p.lat !== original[i].lat || p.lon !== original[i].lon);
  const isAnchor = (i: number) => !changed[i] && fixed[i].lat !== null && fixed[i].lon !== null && times[i] !== null;

  // Find edited windows: runs between anchors that contain an edited point.
  const windows: Window[] = [];
  let offset = 0; // how much later recorded distances must be shifted
  let prevAnchor = -1;
  let sawChange = false;
  const closeWindow = (nextAnchor: number) => {
    const startT = prevAnchor >= 0 ? times[prevAnchor]! : -Infinity;
    const endT = nextAnchor < fixed.length ? times[nextAnchor]! : Infinity;
    const base = prevAnchor >= 0 ? originalAt(startT) + offset : recorded.length ? recD[0] : 0;
    // Walk the fixed track from the anchor before to the anchor after.
    const ts: number[] = [];
    const gs: number[] = [];
    let g = 0;
    let last: TrackPoint | null = null;
    const from = Math.max(0, prevAnchor);
    const to = Math.min(fixed.length - 1, nextAnchor);
    for (let j = from; j <= to; j++) {
      const p = fixed[j];
      if (p.lat === null || p.lon === null || times[j] === null) continue;
      if (last) g += metresBetween(last.lat!, last.lon!, p.lat, p.lon);
      last = p;
      ts.push(times[j]!);
      gs.push(g);
    }
    windows.push({ start: startT, end: endT, base, ts, gs });
    if (Number.isFinite(endT)) offset = base + g - originalAt(endT);
  };
  for (let i = 0; i < fixed.length; i++) {
    if (changed[i]) sawChange = true;
    if (isAnchor(i)) {
      if (sawChange) closeWindow(i);
      prevAnchor = i;
      sawChange = false;
    }
  }
  if (sawChange) closeWindow(fixed.length);

  const fixedAt = (t: number): number => {
    let shift = 0;
    for (const w of windows) {
      if (t > w.start && t < w.end) return w.base + interpolate(w.ts, w.gs, t);
      if (t >= w.end) shift = w.base + (w.gs.length ? w.gs[w.gs.length - 1] : 0) - originalAt(w.end);
    }
    return originalAt(t) + shift;
  };

  return { originalAt, fixedAt };
}
