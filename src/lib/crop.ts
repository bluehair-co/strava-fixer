/**
 * Cropping: cutting off the start and/or end of an activity, e.g. when you
 * forgot to stop recording and drove home.
 *
 * Cropping only ever removes whole samples: every sample (FIT "record"
 * message, GPX track point) recorded before the new start or after the new
 * end. The samples that are kept stay exactly as recorded, except their
 * running distance, which now counts from the new start. In a FIT file the
 * lap and session totals that describe the cropped part (start time, end
 * time, elapsed and timer time, distance and speed) are updated to match,
 * and laps that lie wholly in the cropped part are removed.
 *
 * Cropping is done on a finished file (after fixing or combining), and
 * `verifyCroppedFit` / `verifyCroppedGpx` check the result against that file.
 */

import { FIT_EPOCH_MS, LAP_MESG, RECORD_FIELDS, RECORD_MESG, SESSION_MESG, SUMMARY_FIELDS } from "./fit";
import { buildSegment, checksumProblems, concat, isFit, readMessages, walkFit, type MesgDef, type RawMessage } from "./fitbytes";
import { isGpx, parseGpx } from "./gpx";
import type { TrackPoint } from "./track";

/** The part of the activity to keep. Times in ms since 1970; null means "not cropped on this side". */
export interface Crop {
  start: number | null;
  end: number | null;
}

export const NO_CROP: Crop = { start: null, end: null };

export function isCropped(crop: Crop): boolean {
  return crop.start !== null || crop.end !== null;
}

/** Whether a sample at time `t` (ms) is kept. Samples without a time are always kept. */
export function inCrop(t: number | null, crop: Crop): boolean {
  if (t === null) return true;
  return (crop.start === null || t >= crop.start) && (crop.end === null || t <= crop.end);
}

/**
 * Indexes of the first and last point that cropping keeps, or null if
 * nothing is kept.
 */
export function keptRange(points: TrackPoint[], crop: Crop): [number, number] | null {
  let first = -1;
  let last = -1;
  points.forEach((p, i) => {
    if (!inCrop(p.time, crop)) return;
    if (first < 0) first = i;
    last = i;
  });
  return first < 0 ? null : [first, last];
}

/** Crops a FIT or GPX file and checks the result. */
export function cropFile(bytes: Uint8Array, crop: Crop): { data: Uint8Array; problems: string[] } {
  if (!isCropped(crop)) return { data: bytes, problems: [] };
  if (crop.start !== null && crop.end !== null && crop.end < crop.start) {
    throw new Error("The end of the activity has to come after its start.");
  }
  if (isFit(bytes)) {
    const data = cropFit(bytes, crop);
    return { data, problems: verifyCroppedFit(bytes, data, crop) };
  }
  const text = new TextDecoder().decode(bytes);
  if (isGpx(text)) {
    const cropped = cropGpx(text, crop);
    return { data: new TextEncoder().encode(cropped), problems: verifyCroppedGpx(text, cropped, crop) };
  }
  throw new Error("Only .fit and .gpx files can be cropped.");
}

/* ---------- FIT ---------- */

const FIELD_TIMESTAMP = 253;
const EVENT_MESG = 21;
const EVENT_TIMER = 0;
const TIMER_START = 0;
const TIMER_STOPS = new Set([1, 4, 8, 9]); // stop, stop_all, stop_disable, stop_disable_all
const ELAPSED = 7; // total_elapsed_time (lap and session), ms
const SESSION_NUM_LAPS = 26;

interface Field {
  offset: number;
  size: number;
  littleEndian: boolean;
}

const INVALID: Record<number, number> = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };

function fieldsOf(def: MesgDef, start: number): Map<number, Field> {
  const out = new Map<number, Field>();
  let pos = start + 1;
  for (const f of def.fields) {
    out.set(f.num, { offset: pos, size: f.size, littleEndian: def.littleEndian });
    pos += f.size;
  }
  return out;
}

function read(view: DataView, f: Field | undefined): number | null {
  if (!f || !(f.size in INVALID)) return null;
  const v = f.size === 1 ? view.getUint8(f.offset) : f.size === 2 ? view.getUint16(f.offset, f.littleEndian) : view.getUint32(f.offset, f.littleEndian);
  return v === INVALID[f.size] ? null : v;
}

function write(view: DataView, f: Field | undefined, value: number) {
  if (!f || !(f.size in INVALID) || read(view, f) === null) return; // leave "no value" alone
  const v = Math.min(INVALID[f.size] - 1, Math.max(0, Math.round(value)));
  if (f.size === 1) view.setUint8(f.offset, v);
  else if (f.size === 2) view.setUint16(f.offset, v, f.littleEndian);
  else view.setUint32(f.offset, v, f.littleEndian);
}

/** Crop window in FIT seconds. */
function fitWindow(crop: Crop) {
  const start = crop.start === null ? -Infinity : (crop.start - FIT_EPOCH_MS) / 1000;
  const end = crop.end === null ? Infinity : (crop.end - FIT_EPOCH_MS) / 1000;
  return { start, end, keeps: (t: number | null) => t === null || (t >= start && t <= end) };
}

/** A lap that lies wholly before the new start or after the new end. */
function lapCroppedOff(s: number | null, e: number | null, w: { start: number; end: number }) {
  return s !== null && e !== null && (e < w.start || s > w.end);
}

/**
 * When a lap or session ended (FIT seconds): its timestamp, or if it has
 * none (some apps leave it out), its start plus its elapsed time.
 */
function summaryEnd(start: number | null, timestamp: number | null, elapsedMs: number | null): number | null {
  if (timestamp !== null) return timestamp;
  return start !== null && elapsedMs !== null ? start + Math.round(elapsedMs / 1000) : null;
}

interface Msg {
  def: MesgDef;
  start: number;
  end: number;
  fields: Map<number, Field>;
  time: number | null;
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

export function cropFit(original: Uint8Array, crop: Crop): Uint8Array {
  const bytes = new Uint8Array(original);
  const view = new DataView(bytes.buffer);
  const w = fitWindow(crop);

  const msgs: Msg[] = [];
  walkFit(bytes, {
    data(def, start, end) {
      if (bytes[start] & 0x80) {
        throw new Error("This file stores its times in a compact form that can't be cropped safely.");
      }
      const fields = fieldsOf(def, start);
      const ts = fields.get(FIELD_TIMESTAMP);
      msgs.push({ def, start, end, fields, time: ts && ts.size === 4 ? read(view, ts) : null });
    },
  });

  const records = msgs.filter((m) => m.def.globalNum === RECORD_MESG);
  const kept = records.filter((m) => w.keeps(m.time));
  const keptTimes = kept.map((m) => m.time).filter((t): t is number => t !== null);
  if (keptTimes.length === 0) throw new Error("Cropping there would leave nothing of the activity.");
  const firstKept = Math.min(...keptTimes);
  const lastKept = Math.max(...keptTimes);

  // The file's running distance (m) over time, before cropping.
  const stream = records
    .map((m) => ({ t: m.time, d: read(view, m.fields.get(RECORD_FIELDS.distance)) }))
    .filter((x): x is { t: number; d: number } => x.t !== null && x.d !== null)
    .sort((a, b) => a.t - b.t);
  const xs = stream.map((x) => x.t);
  const ys = stream.map((x) => x.d / 100);
  const distanceAt = (t: number) => interpolate(xs, ys, t);

  // When the timer was running, so cropped pauses don't count as timer time.
  const timer: { t: number; running: boolean }[] = [];
  for (const m of msgs) {
    if (m.def.globalNum !== EVENT_MESG || m.time === null) continue;
    if (read(view, m.fields.get(0)) !== EVENT_TIMER) continue;
    const type = read(view, m.fields.get(1));
    if (type === TIMER_START) timer.push({ t: m.time, running: true });
    else if (type !== null && TIMER_STOPS.has(type)) timer.push({ t: m.time, running: false });
  }
  timer.sort((a, b) => a.t - b.t);
  const runningTime = (a: number, b: number): number => {
    if (b <= a) return 0;
    if (timer.length === 0) return b - a;
    let running = !timer[0].running; // before the first event: the opposite of what it does
    let since = -Infinity;
    let total = 0;
    for (const e of [...timer, { t: Infinity, running: !timer[timer.length - 1].running }]) {
      if (running) total += Math.max(0, Math.min(b, e.t) - Math.max(a, since));
      running = e.running;
      since = e.t;
    }
    return total;
  };

  // 1. Running distance counts from the new start.
  if (crop.start !== null) {
    const offset = Math.min(...kept.map((m) => read(view, m.fields.get(RECORD_FIELDS.distance)) ?? Infinity));
    if (Number.isFinite(offset)) {
      for (const m of kept) {
        const f = m.fields.get(RECORD_FIELDS.distance);
        const cm = read(view, f);
        if (cm !== null) write(view, f, cm - offset);
      }
    }
  }

  // 2. Laps and sessions.
  const removed = new Set<Msg>();
  const sessions: { m: Msg; s: number | null; e: number | null }[] = [];
  const lapTimes = new Map<Msg, number | null>();
  for (const m of msgs) {
    const g = m.def.globalNum;
    if (g !== LAP_MESG && g !== SESSION_MESG) continue;
    const f = SUMMARY_FIELDS[g];
    const sField = m.fields.get(f.startTime);
    const s = sField?.size === 4 ? read(view, sField) : null;
    const e = summaryEnd(s, m.time, read(view, m.fields.get(ELAPSED)));
    if (g === SESSION_MESG) sessions.push({ m, s, e });
    else lapTimes.set(m, s);
    if (lapCroppedOff(s, e, w)) {
      if (g === SESSION_MESG) throw new Error("Cropping there would remove a whole part of a multisport activity.");
      removed.add(m);
      continue;
    }
    if (s === null || e === null) continue;
    const newS = s < w.start ? Math.max(s, firstKept) : s;
    const newE = e > w.end ? Math.min(e, lastKept) : e;
    if (newS === s && newE === e) continue;

    write(view, sField, newS);
    write(view, m.fields.get(FIELD_TIMESTAMP), newE);
    const elapsed = read(view, m.fields.get(ELAPSED));
    if (elapsed !== null) write(view, m.fields.get(ELAPSED), elapsed - ((newS - s) + (e - newE)) * 1000);
    const timerF = m.fields.get(f.timerTime);
    const timerMs = read(view, timerF);
    const newTimer = timerMs === null ? null : Math.max(0, timerMs - (runningTime(s, newS) + runningTime(newE, e)) * 1000);
    if (newTimer !== null) write(view, timerF, newTimer);

    const totalF = m.fields.get(f.totalDistance);
    const cm = read(view, totalF);
    if (cm !== null && stream.length) {
      const cut = distanceAt(newS) - distanceAt(s) + (distanceAt(e) - distanceAt(newE));
      const total = Math.max(0, cm / 100 - cut);
      write(view, totalF, total * 100);
      if (newTimer) {
        write(view, m.fields.get(f.avgSpeed), (total / (newTimer / 1000)) * 1000);
        write(view, m.fields.get(f.enhancedAvgSpeed), (total / (newTimer / 1000)) * 1000);
      }
    }
    let max = -1;
    for (const r of kept) {
      if (r.time === null || r.time < newS || r.time > newE) continue;
      const v = read(view, r.fields.get(RECORD_FIELDS.enhancedSpeed)) ?? read(view, r.fields.get(RECORD_FIELDS.speed));
      if (v !== null && v > max) max = v;
    }
    if (max >= 0) {
      write(view, m.fields.get(f.maxSpeed), max);
      write(view, m.fields.get(f.enhancedMaxSpeed), max);
    }
  }
  // Sessions count their laps.
  for (const { m, s, e } of sessions) {
    const lapsF = m.fields.get(SESSION_NUM_LAPS);
    const n = read(view, lapsF);
    if (n === null) continue;
    const gone = [...removed].filter((lap) => {
      const ls = lapTimes.get(lap) ?? null;
      return sessions.length === 1 || (ls !== null && s !== null && e !== null && ls >= s && ls <= e);
    }).length;
    if (gone) write(view, lapsF, n - gone);
  }

  // 3. Leave out the cropped samples and laps.
  for (const r of records) if (!w.keeps(r.time)) removed.add(r);
  const removedStarts = new Set([...removed].map((m) => m.start));
  const segments: Uint8Array[] = [];
  let header: Uint8Array | null = null;
  let chunks: Uint8Array[] = [];
  walkFit(bytes, {
    segment(seg) {
      header = bytes.slice(seg.start, seg.start + seg.headerSize);
      chunks = [];
    },
    definition(_def, _local, start, end) {
      chunks.push(bytes.subarray(start, end));
    },
    data(_def, start, end) {
      if (!removedStarts.has(start)) chunks.push(bytes.subarray(start, end));
    },
    segmentEnd() {
      segments.push(buildSegment(header!, chunks));
    },
  });
  return concat(segments);
}

/** A message's value for a field, as a number (null if missing or "no value"). */
function value(m: RawMessage, num: number): number | null {
  const hex = m.fields.get(num);
  if (hex === undefined || hex.length > 8) return null;
  const v = parseInt(hex, 16);
  return v === INVALID[hex.length / 2] ? null : v;
}

/**
 * Safety check for a cropped FIT file. Compared with the file before
 * cropping, it must hold exactly the same messages in the same order, minus
 * the samples outside the kept time (all of them) and laps wholly outside it.
 * In the samples that are kept, only the running distance may change, and
 * only downwards. In laps and sessions, only the start time (later), end
 * time, elapsed and timer time and lap count (smaller), distance and speed
 * may change. Returns problems (empty means OK).
 */
export function verifyCroppedFit(before: Uint8Array, after: Uint8Array, crop: Crop): string[] {
  let a: RawMessage[];
  let b: RawMessage[];
  try {
    a = readMessages(before);
    b = readMessages(after);
  } catch {
    return ["The cropped file can't be read back."];
  }
  const problems = checksumProblems(after, "cropped");
  const w = fitWindow(crop);
  const summary = (g: number) => (g === LAP_MESG || g === SESSION_MESG ? SUMMARY_FIELDS[g] : null);

  const sameExceptAllowed = (x: RawMessage, y: RawMessage): string | null => {
    if (x.globalNum !== y.globalNum || x.header !== y.header || x.dev !== y.dev || x.fields.size !== y.fields.size) {
      return "isn't the same kind of message";
    }
    const f = summary(x.globalNum);
    const later = new Set<number>(f ? [f.startTime] : []);
    const smaller = new Set<number>(
      x.globalNum === RECORD_MESG
        ? [RECORD_FIELDS.distance]
        : f
          ? [FIELD_TIMESTAMP, ELAPSED, f.timerTime, f.totalDistance, ...(x.globalNum === SESSION_MESG ? [SESSION_NUM_LAPS] : [])]
          : [],
    );
    const any = new Set<number>(f ? [f.avgSpeed, f.maxSpeed, f.enhancedAvgSpeed, f.enhancedMaxSpeed] : []);
    for (const [num, hex] of x.fields) {
      const other = y.fields.get(num);
      if (other === undefined) return "lost a value";
      if (other === hex || any.has(num)) continue;
      const old = value(x, num);
      const now = value(y, num);
      if (old !== null && now !== null && ((later.has(num) && now >= old) || (smaller.has(num) && now <= old))) continue;
      return `changed a value that cropping doesn't change (field ${num})`;
    }
    return null;
  };

  let j = 0;
  for (let i = 0; i < a.length && problems.length < 6; i++) {
    const x = a[i];
    if (x.globalNum === RECORD_MESG && !w.keeps(value(x, FIELD_TIMESTAMP))) continue; // must be gone
    const f = summary(x.globalNum);
    const s = f ? value(x, f.startTime) : null;
    if (x.globalNum === LAP_MESG && f && lapCroppedOff(s, summaryEnd(s, value(x, FIELD_TIMESTAMP), value(x, ELAPSED)), w)) {
      if (j < b.length && b[j].globalNum === LAP_MESG && !sameExceptAllowed(x, b[j])) j++;
      continue;
    }
    const y = b[j++];
    if (!y) {
      problems.push("Some messages that should be kept are missing from the cropped file.");
      break;
    }
    const why = sameExceptAllowed(x, y);
    if (why) problems.push(`Message ${j} of the cropped file ${why}.`);
  }
  if (j < b.length) problems.push("The cropped file has messages the original doesn't.");
  if (!b.some((m) => m.globalNum === RECORD_MESG)) problems.push("The cropped file has no samples left.");
  for (const y of b) {
    if (y.globalNum === RECORD_MESG && !w.keeps(value(y, FIELD_TIMESTAMP))) {
      problems.push("The cropped file still has samples from the part that was cut off.");
      break;
    }
  }
  return problems;
}

/* ---------- GPX ---------- */

/** The text with the given track point spans (and the line break and indent before each) taken out. */
function without(text: string, spans: { start: number; end: number }[]): string {
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    const lead = /\s*$/.exec(text.slice(cursor, s.start))![0].length;
    out += text.slice(cursor, s.start - lead);
    cursor = s.end;
  }
  return out + text.slice(cursor);
}

export function cropGpx(text: string, crop: Crop): string {
  const parsed = parseGpx(text);
  const cut = parsed.spans.filter((_, i) => !inCrop(parsed.points[i].time, crop));
  if (cut.length === parsed.points.length) throw new Error("Cropping there would leave nothing of the activity.");
  return without(text, cut);
}

/**
 * Safety check for a cropped GPX file: its track points must be exactly the
 * original's points inside the kept time, unchanged and in order, and the
 * rest of the file must be identical.
 */
export function verifyCroppedGpx(before: string, after: string, crop: Crop): string[] {
  let a: ReturnType<typeof parseGpx>;
  let b: ReturnType<typeof parseGpx>;
  try {
    a = parseGpx(before);
    b = parseGpx(after);
  } catch {
    return ["The cropped file can't be read back."];
  }
  const textOf = (text: string, spans: { start: number; end: number }[]) => spans.map((s) => text.slice(s.start, s.end));
  const want = textOf(before, a.spans).filter((_, i) => inCrop(a.points[i].time, crop));
  const got = textOf(after, b.spans);
  if (want.length !== got.length || want.some((p, i) => p !== got[i])) {
    return ["The cropped file's points aren't exactly the original points inside the kept time."];
  }
  if (without(before, a.spans) !== without(after, b.spans)) {
    return ["Something other than track points changed in the cropped file."];
  }
  return [];
}
