/**
 * Finding which activities are the same one: a file in your folder and an
 * activity on Strava, or two files in your folder (e.g. the same run saved
 * by Nike Run Club and by Google Fit).
 *
 *  - "exact": same start (within 3 minutes), same length, same distance
 *    (within 10%), and, when both have GPS, the tracks lie on each other.
 *  - "partial": they overlap in time but something differs: a different
 *    start or end, distance or route, or only one of them has GPS. You
 *    decide whether it's the same activity.
 */

import type { Channel } from "../sources";
import type { ActivitySample } from "./formats";

/** A light copy of a track for comparing and drawing: [lat, lon, time] about every 25 m. */
export interface Preview {
  points: [number, number, number][];
  /** How many GPS points the full file has. */
  gpsCount: number;
}

const R = 6371000;
const toRad = Math.PI / 180;
function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const x = (bLon - aLon) * toRad * Math.cos(((aLat + bLat) / 2) * toRad);
  const y = (bLat - aLat) * toRad;
  return Math.sqrt(x * x + y * y) * R;
}

export function previewOf(samples: ActivitySample[], spacing = 25, max = 2000): Preview | null {
  const gps = samples.filter((s) => s.lat !== undefined && s.lon !== undefined);
  if (!gps.length) return null;
  let kept: [number, number, number][] = [];
  let last: ActivitySample | null = null;
  for (const s of gps) {
    if (!last || metres(last.lat!, last.lon!, s.lat!, s.lon!) >= spacing) {
      kept.push([s.lat!, s.lon!, s.time]);
      last = s;
    }
  }
  const end = gps[gps.length - 1];
  if (kept[kept.length - 1][2] !== end.time) kept.push([end.lat!, end.lon!, end.time]);
  if (kept.length > max) {
    const step = kept.length / max;
    kept = Array.from({ length: max }, (_, i) => kept[Math.floor(i * step)]).concat([kept[kept.length - 1]]);
  }
  return { points: kept, gpsCount: gps.length };
}

/** What we compare: an activity's times, distance, sensors and track. */
export interface Comparable {
  start: number;
  end: number;
  distance: number | null;
  /** null when unknown (e.g. a Strava activity without a file). */
  channels: Channel[] | null;
  preview: Preview | null;
}

export interface Match {
  kind: "exact" | "partial";
  /** Seconds; positive when the other starts later. */
  startDiff: number;
  /** Share of this activity's time the other one also covers (0–1). */
  coverThis: number;
  /** Share of the other's time this one covers (0–1). */
  coverOther: number;
  /** Metres for this one and the other. */
  distanceThis: number | null;
  distanceOther: number | null;
  /** Share of this track lying within 100 m of the other's (0–1), when both have GPS. */
  trackThis: number | null;
  trackOther: number | null;
  /** Kinds of data only this one has, or only the other has. */
  onlyThis: Channel[];
  onlyOther: Channel[];
  gpsThis: number;
  gpsOther: number;
}

const CELL = 100;

/** Share of a's points that lie within about 100 m of a point of b. */
function onTrack(a: Preview, b: Preview): number {
  const lat0 = b.points[0][0];
  const kx = Math.cos(lat0 * toRad) * 111320;
  const ky = 110540;
  const cells = new Map<string, [number, number][]>();
  for (const [lat, lon] of b.points) {
    const key = `${Math.floor((lon * kx) / CELL)},${Math.floor((lat * ky) / CELL)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push([lat, lon]);
  }
  let hits = 0;
  for (const [lat, lon] of a.points) {
    const cx = Math.floor((lon * kx) / CELL);
    const cy = Math.floor((lat * ky) / CELL);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++)
      for (let dy = -1; dy <= 1 && !hit; dy++)
        for (const [blat, blon] of cells.get(`${cx + dx},${cy + dy}`) ?? [])
          if (metres(lat, lon, blat, blon) <= CELL) {
            hit = true;
            break;
          }
    if (hit) hits++;
  }
  return a.points.length ? hits / a.points.length : 0;
}

const SENSORS: Channel[] = ["gps", "heartRate", "cadence", "power", "temperature", "elevation"];

/** Compares two activities; null when they clearly aren't the same one. */
export function compare(a: Comparable, b: Comparable): Match | null {
  const overlap = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  const startDiff = (b.start - a.start) / 1000;
  if (overlap < 60_000 && Math.abs(startDiff) > 15 * 60) return null;
  const durA = Math.max(a.end - a.start, 1000);
  const durB = Math.max(b.end - b.start, 1000);
  const gpsA = !!a.preview;
  const gpsB = !!b.preview;
  const trackThis = gpsA && gpsB ? onTrack(a.preview!, b.preview!) : null;
  const trackOther = gpsA && gpsB ? onTrack(b.preview!, a.preview!) : null;
  // Same time but somewhere else entirely: not the same activity.
  if (trackThis !== null && trackOther !== null && trackThis < 0.05 && trackOther < 0.05) return null;
  const chA = a.channels ?? [];
  const chB = b.channels ?? [];
  const onlyThis = b.channels ? SENSORS.filter((c) => chA.includes(c) && !chB.includes(c)) : [];
  const onlyOther = SENSORS.filter((c) => chB.includes(c) && !chA.includes(c));
  const distRatio = a.distance && b.distance ? Math.min(a.distance, b.distance) / Math.max(a.distance, b.distance) : null;
  const sameTimes = Math.abs(startDiff) <= 180 && Math.abs(durA - durB) <= Math.max(180_000, 0.1 * Math.max(durA, durB));
  const sameDistance = distRatio === null || distRatio >= 0.9;
  const sameTrack = gpsA && gpsB ? trackThis! >= 0.8 && trackOther! >= 0.8 : gpsA === gpsB;
  return {
    kind: sameTimes && sameDistance && sameTrack ? "exact" : "partial",
    startDiff,
    coverThis: overlap / durA,
    coverOther: overlap / durB,
    distanceThis: a.distance,
    distanceOther: b.distance,
    trackThis,
    trackOther,
    onlyThis,
    onlyOther,
    gpsThis: a.preview?.gpsCount ?? 0,
    gpsOther: b.preview?.gpsCount ?? 0,
  };
}

/** Finds, for each of `items`, the activities in `others` it matches (both sorted or not). */
export function findMatches<A extends Comparable, B extends Comparable>(
  items: A[],
  others: B[],
  skip?: (a: A, b: B) => boolean,
): Map<A, { other: B; match: Match }[]> {
  const sorted = [...others].sort((x, y) => x.start - y.start);
  const result = new Map<A, { other: B; match: Match }[]>();
  const DAY = 24 * 3600_000;
  for (const a of items) {
    // First candidate that could overlap (activities longer than a day are ignored).
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].start < a.start - DAY) lo = mid + 1;
      else hi = mid;
    }
    const found: { other: B; match: Match }[] = [];
    for (let i = lo; i < sorted.length && sorted[i].start <= a.end + 15 * 60_000; i++) {
      const b = sorted[i];
      if (skip?.(a, b)) continue;
      const match = compare(a, b);
      if (match) found.push({ other: b, match });
    }
    found.sort((x, y) => (x.match.kind === y.match.kind ? Math.abs(x.match.startDiff) - Math.abs(y.match.startDiff) : x.match.kind === "exact" ? -1 : 1));
    if (found.length) result.set(a, found);
  }
  return result;
}

const CHANNEL_NAMES: Record<Channel, string> = {
  gps: "GPS",
  elevation: "elevation",
  heartRate: "heart rate",
  cadence: "cadence",
  power: "power",
  temperature: "temperature",
};

const km = (m: number) => `${(m / 1000).toFixed(2)} km`;
const mins = (s: number) => (Math.abs(s) < 90 ? `${Math.round(Math.abs(s))} s` : `${Math.round(Math.abs(s) / 60)} min`);
const pct = (f: number) => `${Math.round(f * 100)}%`;

/** Plain-language reasons, from this file's point of view ("the other" being e.g. "the Strava activity"). */
export function describe(m: Match, other: string): string[] {
  const out: string[] = [];
  out.push(Math.abs(m.startDiff) < 5 ? "Starts at the same moment." : `${other[0].toUpperCase() + other.slice(1)} starts ${mins(m.startDiff)} ${m.startDiff > 0 ? "later" : "earlier"}.`);
  if (m.coverThis < 0.97 || m.coverOther < 0.97)
    out.push(`They overlap for ${pct(m.coverThis)} of this file's time and ${pct(m.coverOther)} of ${other}'s.`);
  if (m.distanceThis && m.distanceOther) {
    const r = Math.min(m.distanceThis, m.distanceOther) / Math.max(m.distanceThis, m.distanceOther);
    out.push(r >= 0.98 ? `Same distance (${km(m.distanceThis)}).` : `Distance: ${km(m.distanceThis)} here, ${km(m.distanceOther)} in ${other}.`);
  }
  if (m.trackThis !== null && m.trackOther !== null) {
    if (m.trackThis >= 0.95 && m.trackOther >= 0.95) out.push("The GPS tracks lie on top of each other.");
    else out.push(`${pct(m.trackThis)} of this track lies on ${other}'s, and ${pct(m.trackOther)} of ${other}'s on this one.`);
    if (m.gpsThis > m.gpsOther * 1.5) out.push(`This file has more GPS points (${m.gpsThis.toLocaleString()} vs ${m.gpsOther.toLocaleString()}).`);
    else if (m.gpsOther > m.gpsThis * 1.5) out.push(`${other[0].toUpperCase() + other.slice(1)} has more GPS points (${m.gpsOther.toLocaleString()} vs ${m.gpsThis.toLocaleString()}).`);
  }
  if (m.onlyThis.length) out.push(`Only this file has ${m.onlyThis.map((c) => CHANNEL_NAMES[c]).join(", ")}.`);
  if (m.onlyOther.length) out.push(`Only ${other} has ${m.onlyOther.map((c) => CHANNEL_NAMES[c]).join(", ")}.`);
  return out;
}
