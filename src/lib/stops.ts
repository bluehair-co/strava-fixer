/**
 * Finding stops, and the time spent standing still at the start and end.
 *
 * When you stand still, GPS doesn't: the position keeps wandering around by
 * a few metres, often adding a hundred metres or more of distance you never
 * rode. This finds those moments from the GPS positions and their times only
 * (nothing else in the file is looked at or changed):
 *
 * - A stop is a stretch of at least `minStopSeconds` during which every
 *   position stays within `radius` metres of the stretch's middle. It can be
 *   straightened (see `straighten` in track.ts), which removes the wandering.
 * - Idle time at the start (or end) is the same kind of stretch at the very
 *   beginning (or end) of the GPS track. Cropping it off makes the activity
 *   start just before you started moving and end just after you stopped.
 */

import type { Crop } from "./crop";
import { metresBetween, straighten, type TrackPoint } from "./track";

export interface TidySettings {
  /** How far (metres) the GPS may wander while you're standing still. */
  radius: number;
  /** How long (seconds) you have to stand still for it to count as a stop. */
  minStopSeconds: number;
  /** Seconds of standing still to keep before you start moving and after you stop. */
  keepSeconds: number;
}

export const DEFAULT_TIDY: TidySettings = { radius: 30, minStopSeconds: 60, keepSeconds: 5 };

/** A moment where you stood still. `from` and `to` are point indexes. */
export interface Stop {
  from: number;
  to: number;
  /** Times (ms) of the first and last point. */
  start: number;
  end: number;
  /** Distance the GPS track covers during the stop, in metres. */
  wander: number;
  /** Straight-line distance between the first and last point, in metres. */
  straight: number;
  /**
   * True if the points of this stop are already on a straight line, or so
   * close to one that straightening would remove less than NOT_WORTH metres.
   */
  straightened: boolean;
}

export interface TidyResult {
  stops: Stop[];
  /** Index of the last point of the idle time at the start, or null if there's none. */
  idleStart: number | null;
  /** Index of the first point of the idle time at the end, or null if there's none. */
  idleEnd: number | null;
  /** The crop that cuts off the idle time (keeping `keepSeconds`), or null sides where there's none. */
  crop: Crop;
}

/** Shorter still moments are ignored, at the ends too (it's just GPS noise). */
const MIN_IDLE_MS = 10_000;
/** Two still moments this close in time, and within the radius of each other, are one stop. */
const JOIN_GAP_MS = 120_000;
/** Straightening a stop that would shorten it by less than this (metres) isn't worth it. */
const NOT_WORTH = 10;
/** How many positions in a row may jump outside the radius without ending a stop. */
const MAX_JUMPS = 2;

interface Fix {
  index: number;
  lat: number;
  lon: number;
  time: number;
}

function centre(fixes: Fix[], a: number, b: number): { lat: number; lon: number } {
  let lat = 0;
  let lon = 0;
  for (let k = a; k <= b; k++) {
    lat += fixes[k].lat;
    lon += fixes[k].lon;
  }
  return { lat: lat / (b - a + 1), lon: lon / (b - a + 1) };
}

const metres = (p: { lat: number; lon: number }, q: { lat: number; lon: number }) =>
  metresBetween(p.lat, p.lon, q.lat, q.lon);

/**
 * How far the still moment starting at fix `a` goes: fixes are added while
 * each new one is within `radius` of the middle of the ones before it.
 * Returns the last fix that belongs to it.
 */
function growStill(fixes: Fix[], a: number, radius: number, step: 1 | -1): number {
  let lat = fixes[a].lat;
  let lon = fixes[a].lon;
  let count = 1;
  let b = a;
  let jumps = 0;
  for (let k = a + step; k >= 0 && k < fixes.length; k += step) {
    if (metres({ lat: lat / count, lon: lon / count }, fixes[k]) > radius) {
      // A single GPS jump doesn't end a stop; a few in a row do (you've left).
      if (++jumps > MAX_JUMPS) break;
      continue;
    }
    jumps = 0;
    lat += fixes[k].lat;
    lon += fixes[k].lon;
    count++;
    b = k;
  }
  return b;
}

/**
 * Drops fixes at either edge of a still moment that are more than half the
 * radius from its middle: that's you slowing down or setting off.
 */
function trim(fixes: Fix[], a: number, b: number, radius: number): [number, number] {
  const c = centre(fixes, a, b);
  while (a < b && metres(fixes[a], c) > radius / 2) a++;
  while (b > a && metres(fixes[b], c) > radius / 2) b--;
  return [a, b];
}

/** Every still moment of at least MIN_IDLE_MS, as [first, last] fix, in order. */
function stillMoments(fixes: Fix[], radius: number): [number, number][] {
  const found: [number, number][] = [];
  let a = 0;
  while (a < fixes.length) {
    const b = growStill(fixes, a, radius, 1);
    if (fixes[b].time - fixes[a].time >= MIN_IDLE_MS) {
      found.push([a, b]);
      a = b + 1;
    } else {
      a++;
    }
  }
  // GPS wandering a bit too far splits one stop in two: join them again.
  const joined: [number, number][] = [];
  for (const [a, b] of found) {
    const prev = joined[joined.length - 1];
    if (
      prev &&
      fixes[a].time - fixes[prev[1]].time <= JOIN_GAP_MS &&
      metres(centre(fixes, prev[0], prev[1]), centre(fixes, a, b)) <= radius
    ) {
      prev[1] = b;
    } else {
      joined.push([a, b]);
    }
  }
  return joined.map(([a, b]) => trim(fixes, a, b, radius));
}

function pathLength(points: TrackPoint[], from: number, to: number): number {
  let total = 0;
  let prev: TrackPoint | null = null;
  for (let i = from; i <= to; i++) {
    const p = points[i];
    if (p.lat === null || p.lon === null) continue;
    if (prev) total += metresBetween(prev.lat!, prev.lon!, p.lat, p.lon);
    prev = p;
  }
  return total;
}

function isStraight(points: TrackPoint[], from: number, to: number): boolean {
  const line = straighten(points, from, to);
  for (let i = from + 1; i < to; i++) {
    const p = points[i];
    const q = line[i];
    if (p.lat === null || p.lon === null) continue;
    if (metresBetween(p.lat, p.lon, q.lat!, q.lon!) > 0.05) return false;
  }
  return true;
}

/**
 * Finds the stops, and the idle time at the start and end, in a track.
 * Only points with both a position and a time are looked at.
 */
export function findStops(points: TrackPoint[], settings: TidySettings = DEFAULT_TIDY): TidyResult {
  const { radius, minStopSeconds, keepSeconds } = settings;
  const fixes: Fix[] = [];
  points.forEach((p, index) => {
    if (p.lat === null || p.lon === null || p.time === null) return;
    // Times must go forwards; skip anything that doesn't.
    if (fixes.length && p.time < fixes[fixes.length - 1].time) return;
    fixes.push({ index, lat: p.lat, lon: p.lon, time: p.time });
  });
  const none: TidyResult = { stops: [], idleStart: null, idleEnd: null, crop: { start: null, end: null } };
  if (fixes.length < 3) return none;
  const last = fixes.length - 1;

  // Idle at the start: still from the very first fix (and the same at the end).
  let startFix: number | null = null;
  const s = trim(fixes, 0, growStill(fixes, 0, radius, 1), radius)[1];
  if (fixes[s].time - fixes[0].time >= MIN_IDLE_MS) startFix = s;
  let endFix: number | null = null;
  const e = trim(fixes, growStill(fixes, last, radius, -1), last, radius)[0];
  if (fixes[last].time - fixes[e].time >= MIN_IDLE_MS) endFix = e;
  // Standing still the whole time: there's no movement to keep.
  if (startFix !== null && endFix !== null && endFix <= startFix) return none;

  const keep = keepSeconds * 1000;
  const firstTime = points.find((p) => p.time !== null)?.time ?? null;
  const lastTime = points.findLast((p) => p.time !== null)?.time ?? null;
  const cropStart = startFix === null ? null : fixes[startFix].time - keep;
  const cropEnd = endFix === null ? null : fixes[endFix].time + keep;

  const stops: Stop[] = [];
  for (const [a, b] of stillMoments(fixes, radius)) {
    // Still moments at the very start or end are the idle time, not stops.
    if ((startFix !== null && a <= startFix) || (endFix !== null && b >= endFix)) continue;
    if (a === 0 || b === last) continue;
    if (fixes[b].time - fixes[a].time < minStopSeconds * 1000) continue;
    const from = fixes[a].index;
    const to = fixes[b].index;
    const wander = pathLength(points, from, to);
    const straight = metres(fixes[a], fixes[b]);
    stops.push({
      from,
      to,
      start: fixes[a].time,
      end: fixes[b].time,
      wander,
      straight,
      straightened: wander - straight < NOT_WORTH || isStraight(points, from, to),
    });
  }

  return {
    stops,
    idleStart: startFix === null ? null : fixes[startFix].index,
    idleEnd: endFix === null ? null : fixes[endFix].index,
    crop: {
      start: cropStart === null || firstTime === null || cropStart <= firstTime ? null : cropStart,
      end: cropEnd === null || lastTime === null || cropEnd >= lastTime ? null : cropEnd,
    },
  };
}

/** Straightens the given stops (each one onto the line from its first to its last point). */
export function straightenStops(points: TrackPoint[], stops: Stop[]): TrackPoint[] {
  return stops.reduce((pts, s) => straighten(pts, s.from, s.to), points.slice());
}

/**
 * Straightens every stop found with these settings. Once pieces of a stop
 * are straightened they can turn out to be one stop, so it looks again (a
 * few times at most) until nothing is left to straighten.
 */
export function straightenAllStops(points: TrackPoint[], settings: TidySettings = DEFAULT_TIDY): TrackPoint[] {
  let pts = points;
  for (let round = 0; round < 5; round++) {
    const todo = findStops(pts, settings).stops.filter((s) => !s.straightened);
    if (todo.length === 0) break;
    pts = straightenStops(pts, todo);
  }
  return pts;
}
