/**
 * Merging two recordings of the same activity, e.g. a watch that didn't get a
 * GPS signal (or only got one late) and a phone that did.
 *
 * One file is the "base": its heart rate, cadence, power, elevation, laps,
 * timestamps and everything else are kept exactly as recorded. The other file
 * only lends its GPS track: for every sample in the base file we look up
 * where the other recording was at that moment (interpolating between its
 * points) and write that position in. Distance and speed are then
 * recalculated from the new track, exactly as when fixing points by hand.
 *
 * A watch that never found GPS often writes its samples without any position
 * fields at all, so there is nowhere to put a position. In that case we
 * first add empty latitude/longitude fields to those samples (this makes the
 * file 8 bytes longer per sample, but every recorded value stays the same).
 *
 * The result is checked by `verifyMergedFit` / `verifyGpx`, which compare it
 * with the base file value by value and refuse if anything but positions,
 * distance or speed differs.
 */

import { LAP_MESG, parseFit, RECORD_FIELDS, RECORD_MESG, SESSION_MESG, SUMMARY_FIELDS, writeFit } from "./fit";
import { buildSegment, checksumProblems, concat, isFit, readMessages, walkFit, type MesgDef, type RawMessage } from "./fitbytes";
import { isGpx, parseGpx, verifyGpx, writeGpx } from "./gpx";
import type { TrackPoint } from "./track";

const FIELD_LAT = 0;
const FIELD_LON = 1;
const SINT32 = 0x85; // FIT base type for a signed 32-bit number
const INVALID_SINT32 = 0x7fffffff;

/* ---------- Adding position fields ---------- */

/**
 * Returns a copy of a FIT file in which every sample ("record" message) has
 * latitude and longitude fields, adding empty ones where they're missing.
 * Returns the original bytes unchanged if nothing needed adding.
 */
export function addPositionFields(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  // How many bytes each local message type gains, and where to insert them.
  const extra = new Map<MesgDef, Uint8Array>();
  let segHeader: Uint8Array | null = null;
  let segChunks: Uint8Array[] = [];
  let added = false;

  walkFit(bytes, {
    segment(seg) {
      segHeader = bytes.slice(seg.start, seg.start + seg.headerSize);
      segChunks = [];
    },
    definition(def, _localType, start, end) {
      const has = (num: number) => def.fields.some((f) => f.num === num);
      const missing = def.globalNum === RECORD_MESG ? [FIELD_LAT, FIELD_LON].filter((n) => !has(n)) : [];
      if (missing.length === 0 || def.fields.length + missing.length > 255) {
        segChunks.push(bytes.subarray(start, end));
        return;
      }
      added = true;
      const fieldsEnd = def.countOffset + 1 + def.fields.length * 3;
      const head = bytes.slice(start, fieldsEnd);
      head[def.countOffset - start] = def.fields.length + missing.length;
      const newDefs = new Uint8Array(missing.flatMap((n) => [n, 4, SINT32]));
      segChunks.push(head, newDefs, bytes.subarray(fieldsEnd, end));
      const empty = new Uint8Array(4 * missing.length);
      const view = new DataView(empty.buffer);
      missing.forEach((_, i) => view.setInt32(i * 4, INVALID_SINT32, def.littleEndian));
      extra.set(def, empty);
    },
    data(def, start, end) {
      const add = extra.get(def);
      if (!add) {
        segChunks.push(bytes.subarray(start, end));
        return;
      }
      // New fields go after the normal fields, before any developer fields.
      const fieldsEnd = start + 1 + def.fieldsSize;
      segChunks.push(bytes.subarray(start, fieldsEnd), add, bytes.subarray(fieldsEnd, end));
    },
    segmentEnd() {
      chunks.push(buildSegment(segHeader!, segChunks));
    },
  });
  return added ? concat(chunks) : bytes;
}

/**
 * Safety check for a merged FIT file: every message of the base file must
 * still be there, in the same order, with every value identical, except
 * positions, distance and speed. The only fields allowed to be new are
 * latitude/longitude on samples. Returns problems (empty means OK).
 */
export function verifyMergedFit(base: Uint8Array, merged: Uint8Array): string[] {
  let a: RawMessage[];
  let b: RawMessage[];
  try {
    a = readMessages(base);
    b = readMessages(merged);
  } catch {
    return ["The merged file can't be read back."];
  }
  const problems = checksumProblems(merged, "merged");
  if (a.length !== b.length) return [...problems, "The merged file has a different number of messages."];

  const changeable = new Map<number, Set<number>>([
    [RECORD_MESG, new Set([FIELD_LAT, FIELD_LON, ...Object.values(RECORD_FIELDS)])],
    [LAP_MESG, new Set(summaryFields(LAP_MESG))],
    [SESSION_MESG, new Set(summaryFields(SESSION_MESG))],
  ]);
  for (let i = 0; i < a.length && problems.length < 6; i++) {
    const x = a[i];
    const y = b[i];
    if (x.globalNum !== y.globalNum || x.header !== y.header || x.dev !== y.dev) {
      problems.push(`Message ${i + 1} changed.`);
      continue;
    }
    const allowed = changeable.get(x.globalNum);
    for (const [num, value] of x.fields) {
      if (y.fields.get(num) !== value && !allowed?.has(num)) {
        problems.push(`A value in message ${i + 1} changed, but it isn't a GPS position, distance or speed.`);
        break;
      }
    }
    for (const num of y.fields.keys()) {
      if (!x.fields.has(num) && !(x.globalNum === RECORD_MESG && (num === FIELD_LAT || num === FIELD_LON))) {
        problems.push(`Message ${i + 1} gained a field that isn't a GPS position.`);
        break;
      }
    }
  }
  return problems;
}

function summaryFields(mesg: typeof LAP_MESG | typeof SESSION_MESG): number[] {
  const { totalDistance, avgSpeed, maxSpeed, enhancedAvgSpeed, enhancedMaxSpeed } = SUMMARY_FIELDS[mesg];
  return [totalDistance, avgSpeed, maxSpeed, enhancedAvgSpeed, enhancedMaxSpeed];
}

/* ---------- Lining up the two tracks ---------- */

/** Longest gap (ms) in the GPS recording we'll interpolate across. */
export const MAX_GAP_MS = 60_000;

/**
 * Where the GPS recording was at each of the given times, interpolated
 * between its two nearest points. null where it has no position close enough
 * in time (before it started, after it stopped, or in a long gap).
 */
export function positionsAt(gps: TrackPoint[], times: (number | null)[]): ({ lat: number; lon: number } | null)[] {
  const pts = gps
    .filter((p) => p.lat !== null && p.lon !== null && p.time !== null)
    .sort((p, q) => p.time! - q.time!) as { lat: number; lon: number; time: number }[];
  return times.map((t) => {
    if (t === null || pts.length === 0 || t < pts[0].time || t > pts[pts.length - 1].time) return null;
    let lo = 0;
    let hi = pts.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].time <= t) lo = mid;
      else hi = mid;
    }
    const p = pts[lo];
    const q = pts[hi];
    if (p.time === t) return { lat: p.lat, lon: p.lon };
    if (q.time === t) return { lat: q.lat, lon: q.lon };
    if (q.time - p.time > MAX_GAP_MS) return null;
    const f = (t - p.time) / (q.time - p.time);
    return { lat: p.lat + (q.lat - p.lat) * f, lon: p.lon + (q.lon - p.lon) * f };
  });
}

/* ---------- Merging ---------- */

export type MergeMode =
  /** Use the other recording's GPS wherever it has a position. */
  | "replace"
  /** Only fill in samples of the base file that have no GPS position. */
  | "fill";

export interface MergeResult {
  kind: "fit" | "gpx";
  data: Uint8Array;
  /** The merged track, one point per sample of the base file. */
  points: TrackPoint[];
  /** How many samples got a new position. */
  changed: number;
  /** How many samples are still without a position. */
  missing: number;
  problems: string[];
}

/**
 * Builds one file from `base` (all its sensor data kept) with GPS positions
 * taken from `gps`, lined up by time.
 */
export function mergeActivities(base: Uint8Array, gps: TrackPoint[], mode: MergeMode): MergeResult {
  return mergePositions(base, (points) => {
    if (!points.some((p) => p.time !== null)) {
      throw new Error("The file with the heart rate and other data has no times, so the two can't be lined up.");
    }
    const found = positionsAt(gps, points.map((p) => p.time));
    if (!found.some(Boolean)) {
      throw new Error("The two recordings don't overlap in time. Are they of the same activity?");
    }
    return points.map((p, i) => {
      const pos = found[i];
      if (!pos) return undefined;
      if (mode === "fill" && p.lat !== null && p.lon !== null) return undefined;
      return pos;
    });
  });
}

/**
 * For each sample of the base file: a new position, null to remove its
 * position, or undefined to keep it as it is.
 */
export type PositionPicker = (points: TrackPoint[]) => ({ lat: number; lon: number } | null | undefined)[];

/**
 * Builds one file from `base` (all its sensor data kept) with positions
 * chosen by `pick`. Removing positions only works for FIT files (a GPX
 * track point always has one), so a GPX point asked to lose its position
 * keeps it.
 */
export function mergePositions(base: Uint8Array, pick: PositionPicker): MergeResult {
  if (isFit(base)) {
    const expanded = addPositionFields(base);
    const parsed = parseFit(expanded);
    // Some files (like Strava app recordings) store heart rate, distance and
    // position in separate samples with the same time. Only give a position
    // to a sample that got new position fields if no other sample at that
    // time already has room for one.
    const before = parseFit(base);
    const slotted = new Set(before.points.map((p) => p.time));
    const skip = new Array<boolean>(parsed.points.length).fill(false);
    before.records.forEach((rec, i) => {
      const point = parsed.records[i].point;
      if (rec.point < 0 && point >= 0 && slotted.has(parsed.points[point].time)) skip[point] = true;
    });
    const picked = pick(parsed.points);
    const points = parsed.points.map((p, i) => {
      const pos = picked[i];
      if (pos === undefined || (skip[i] && pos !== null)) return p;
      return { ...p, lat: pos === null ? null : pos.lat, lon: pos === null ? null : pos.lon };
    });
    const data = writeFit(expanded, parsed, points);
    return { kind: "fit", data, points, ...counts(parsed.points, points), problems: verifyMergedFit(base, data) };
  }
  const text = new TextDecoder().decode(base);
  if (isGpx(text)) {
    const parsed = parseGpx(text);
    const picked = pick(parsed.points);
    const points = parsed.points.map((p, i) => {
      const pos = picked[i];
      return pos ? { ...p, lat: pos.lat, lon: pos.lon } : p;
    });
    const merged = writeGpx(text, parsed, points);
    return {
      kind: "gpx",
      data: new TextEncoder().encode(merged),
      points,
      ...counts(parsed.points, points),
      problems: verifyGpx(text, merged, parsed),
    };
  }
  throw new Error("The file with the heart rate and other data must be a .fit or .gpx file.");
}

function counts(before: TrackPoint[], after: TrackPoint[]) {
  let changed = 0;
  let missing = 0;
  after.forEach((p, i) => {
    if (p.lat !== before[i].lat || p.lon !== before[i].lon) changed++;
    if (p.lat === null || p.lon === null) missing++;
  });
  return { changed, missing };
}

/** Turns "Morning_Ride.fit" into "Morning_Ride-merged.fit". */
export function mergedFileName(name: string, kind: "fit" | "gpx"): string {
  const base = name.replace(/\.gz$/i, "").replace(/\.(fit|gpx)$/i, "");
  return `${base}-merged.${kind}`;
}
