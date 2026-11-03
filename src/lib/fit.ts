/**
 * Minimal FIT file reader/writer that only touches GPS positions and the
 * values derived from them (distance and speed).
 *
 * Instead of decoding the file into objects and re-encoding it (which can
 * silently drop fields the encoder doesn't know about), we walk the raw bytes,
 * remember exactly where the fields we may change are stored, and later
 * overwrite just those bytes. Every other byte of the file stays identical,
 * apart from the 2-byte checksum at the end of each FIT segment, which has to
 * be recalculated because the data changed.
 *
 * What may change:
 *  - record: position_lat, position_long, and for fixed points distance,
 *    speed and enhanced_speed
 *  - lap / session: total_distance, avg/max speed (and their "enhanced"
 *    versions), recalculated from the fixed records
 *
 * FIT format reference: https://developer.garmin.com/fit/protocol/
 */

import { buildDistanceModel } from "./distance";
import { stepDistances, type TrackPoint } from "./track";

export const SESSION_MESG = 18;
export const LAP_MESG = 19;
export const RECORD_MESG = 20; // "record" messages hold one sample (position, HR, ...)
const FIELD_LAT = 0; // position_lat, sint32 semicircles
const FIELD_LON = 1; // position_long, sint32 semicircles
const FIELD_TIMESTAMP = 253; // uint32 seconds since FIT epoch
const INVALID_SINT32 = 0x7fffffff; // FIT's "no value" marker for sint32
const INVALID_UINT32 = 0xffffffff;
const INVALID_UINT16 = 0xffff;

// Field numbers (from the FIT profile) of values we recalculate.
// Distances are stored in centimetres, speeds in mm/s.
export const RECORD_FIELDS = { distance: 5, speed: 6, enhancedSpeed: 73 } as const;
export const SUMMARY_FIELDS = {
  [LAP_MESG]: { startTime: 2, timerTime: 8, totalDistance: 9, avgSpeed: 13, maxSpeed: 14, enhancedAvgSpeed: 110, enhancedMaxSpeed: 111 },
  [SESSION_MESG]: { startTime: 2, timerTime: 8, totalDistance: 9, avgSpeed: 14, maxSpeed: 15, enhancedAvgSpeed: 124, enhancedMaxSpeed: 125 },
} as const;
export const FIT_EPOCH_MS = Date.UTC(1989, 11, 31, 0, 0, 0);
const SEMICIRCLES_PER_DEGREE = 2 ** 31 / 180;

/** Where a record's position lives inside the file. */
export interface FitPositionSlot {
  latOffset: number;
  lonOffset: number;
  littleEndian: boolean;
}

export interface FitSegment {
  /** Byte offset of the segment's header. */
  start: number;
  headerSize: number;
  dataSize: number;
}

/** A number stored at a known place in the file. */
interface Slot {
  offset: number;
  size: 2 | 4;
  littleEndian: boolean;
}

/** Every record message, including ones without a position. */
export interface FitRecord {
  /** FIT timestamp (seconds since 1989-12-31), or null. */
  time: number | null;
  /** Index into `points`, or -1 if this record has no position fields. */
  point: number;
  distance?: Slot;
  speed?: Slot;
  enhancedSpeed?: Slot;
}

/** A lap or session summary. */
export interface FitSummary {
  kind: "lap" | "session";
  startTime: number | null;
  endTime: number | null;
  /** Timer time in seconds (excludes pauses), or null. */
  timerTime: number | null;
  totalDistance?: Slot;
  avgSpeed?: Slot;
  maxSpeed?: Slot;
  enhancedAvgSpeed?: Slot;
  enhancedMaxSpeed?: Slot;
}

export interface ParsedFit {
  points: TrackPoint[];
  slots: FitPositionSlot[];
  records: FitRecord[];
  summaries: FitSummary[];
  segments: FitSegment[];
}

interface FieldDef {
  num: number;
  size: number;
}

interface MesgDef {
  globalNum: number;
  littleEndian: boolean;
  fields: FieldDef[];
  devFieldsSize: number;
}

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001,
  0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

export function fitCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    const byte = bytes[i];
    let tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
  }
  return crc;
}

export function isFit(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[8] === 0x2e && // .
    bytes[9] === 0x46 && // F
    bytes[10] === 0x49 && // I
    bytes[11] === 0x54 // T
  );
}

export function semicirclesToDegrees(value: number): number {
  return value / SEMICIRCLES_PER_DEGREE;
}

export function degreesToSemicircles(value: number): number {
  return Math.round(value * SEMICIRCLES_PER_DEGREE);
}

/** Reads every record's position (and its time) from a FIT file. */
export function parseFit(bytes: Uint8Array): ParsedFit {
  if (!isFit(bytes)) throw new Error("This doesn't look like a FIT file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const points: TrackPoint[] = [];
  const slots: FitPositionSlot[] = [];
  const records: FitRecord[] = [];
  const summaries: FitSummary[] = [];
  const segments: FitSegment[] = [];

  let segStart = 0;
  // A FIT file can be several FIT "segments" glued together (chained FIT).
  while (segStart + 12 <= bytes.length && isFit(bytes.subarray(segStart))) {
    const headerSize = bytes[segStart];
    const dataSize = view.getUint32(segStart + 4, true);
    const dataEnd = segStart + headerSize + dataSize;
    if (dataEnd + 2 > bytes.length) {
      throw new Error("The FIT file is shorter than its header says. Is it complete?");
    }
    segments.push({ start: segStart, headerSize, dataSize });

    const defs = new Map<number, MesgDef>();
    let lastTimestamp = 0;
    let pos = segStart + headerSize;

    while (pos < dataEnd) {
      const header = bytes[pos++];
      let localType: number;
      let compressedOffset: number | null = null;

      if (header & 0x80) {
        // Compressed timestamp header: always a data message.
        localType = (header >> 5) & 0x03;
        compressedOffset = header & 0x1f;
      } else if (header & 0x40) {
        // Definition message: describes the layout of later data messages.
        localType = header & 0x0f;
        const hasDevData = (header & 0x20) !== 0;
        const littleEndian = bytes[pos + 1] === 0;
        const globalNum = view.getUint16(pos + 2, littleEndian);
        const numFields = bytes[pos + 4];
        pos += 5;
        const fields: FieldDef[] = [];
        for (let i = 0; i < numFields; i++) {
          fields.push({ num: bytes[pos], size: bytes[pos + 1] });
          pos += 3;
        }
        let devFieldsSize = 0;
        if (hasDevData) {
          const numDev = bytes[pos++];
          for (let i = 0; i < numDev; i++) {
            devFieldsSize += bytes[pos + 1];
            pos += 3;
          }
        }
        defs.set(localType, { globalNum, littleEndian, fields, devFieldsSize });
        continue;
      } else {
        localType = header & 0x0f;
      }

      const def = defs.get(localType);
      if (!def) {
        throw new Error(`The FIT file uses a message type before defining it (at byte ${pos - 1}).`);
      }

      // Note where each field of this message starts.
      const at = new Map<number, Slot>();
      let timestamp: number | null = null;
      for (const field of def.fields) {
        if (field.num === FIELD_TIMESTAMP && field.size === 4) {
          timestamp = view.getUint32(pos, def.littleEndian);
        }
        if (field.size === 2 || field.size === 4) {
          at.set(field.num, { offset: pos, size: field.size, littleEndian: def.littleEndian });
        }
        pos += field.size;
      }
      pos += def.devFieldsSize;

      if (timestamp !== null) {
        lastTimestamp = timestamp;
      } else if (compressedOffset !== null) {
        const base = lastTimestamp & ~0x1f;
        timestamp =
          compressedOffset >= (lastTimestamp & 0x1f)
            ? base + compressedOffset
            : base + compressedOffset + 0x20;
        lastTimestamp = timestamp;
      }

      const sized = (num: number, size: 2 | 4) => {
        const slot = at.get(num);
        return slot && slot.size === size ? slot : undefined;
      };

      if (def.globalNum === RECORD_MESG) {
        const latSlot = sized(FIELD_LAT, 4);
        const lonSlot = sized(FIELD_LON, 4);
        let point = -1;
        if (latSlot && lonSlot) {
          const lat = view.getInt32(latSlot.offset, def.littleEndian);
          const lon = view.getInt32(lonSlot.offset, def.littleEndian);
          const valid = lat !== INVALID_SINT32 && lon !== INVALID_SINT32;
          point = points.length;
          points.push({
            lat: valid ? semicirclesToDegrees(lat) : null,
            lon: valid ? semicirclesToDegrees(lon) : null,
            time: timestamp !== null ? FIT_EPOCH_MS + timestamp * 1000 : null,
          });
          slots.push({ latOffset: latSlot.offset, lonOffset: lonSlot.offset, littleEndian: def.littleEndian });
        }
        records.push({
          time: timestamp,
          point,
          distance: sized(RECORD_FIELDS.distance, 4),
          speed: sized(RECORD_FIELDS.speed, 2),
          enhancedSpeed: sized(RECORD_FIELDS.enhancedSpeed, 4),
        });
      } else if (def.globalNum === LAP_MESG || def.globalNum === SESSION_MESG) {
        const f = SUMMARY_FIELDS[def.globalNum];
        const start = sized(f.startTime, 4);
        const timer = sized(f.timerTime, 4);
        const startTime = start ? view.getUint32(start.offset, def.littleEndian) : INVALID_UINT32;
        const timerTime = timer ? view.getUint32(timer.offset, def.littleEndian) : INVALID_UINT32;
        summaries.push({
          kind: def.globalNum === LAP_MESG ? "lap" : "session",
          startTime: startTime === INVALID_UINT32 ? null : startTime,
          endTime: timestamp,
          timerTime: timerTime === INVALID_UINT32 ? null : timerTime / 1000,
          totalDistance: sized(f.totalDistance, 4),
          avgSpeed: sized(f.avgSpeed, 2),
          maxSpeed: sized(f.maxSpeed, 2),
          enhancedAvgSpeed: sized(f.enhancedAvgSpeed, 4),
          enhancedMaxSpeed: sized(f.enhancedMaxSpeed, 4),
        });
      }
    }
    segStart = dataEnd + 2;
  }

  if (segments.length === 0) throw new Error("This doesn't look like a FIT file.");
  return { points, slots, records, summaries, segments };
}

function readSlot(view: DataView, slot: Slot): number | null {
  if (slot.size === 2) {
    const v = view.getUint16(slot.offset, slot.littleEndian);
    return v === INVALID_UINT16 ? null : v;
  }
  const v = view.getUint32(slot.offset, slot.littleEndian);
  return v === INVALID_UINT32 ? null : v;
}

function writeSlot(view: DataView, slot: Slot, value: number) {
  const max = slot.size === 2 ? INVALID_UINT16 - 1 : INVALID_UINT32 - 1;
  const v = Math.min(max, Math.max(0, Math.round(value)));
  if (slot.size === 2) view.setUint16(slot.offset, v, slot.littleEndian);
  else view.setUint32(slot.offset, v, slot.littleEndian);
}

/**
 * Returns a copy of the original file with the positions replaced and the
 * distance and speed values that depend on them recalculated.
 * A point with lat/lon of null is written as "no position" (FIT's invalid value).
 *
 * Distance is adjusted rather than recomputed from scratch: for every step
 * between two points we add the difference between the fixed and the original
 * straight-line distance. Steps you didn't touch keep the watch's own
 * distance, which may come from a wheel sensor or foot pod and is often
 * smoother than raw GPS.
 */
export function writeFit(original: Uint8Array, parsed: ParsedFit, points: TrackPoint[]): Uint8Array {
  if (points.length !== parsed.slots.length) {
    throw new Error("Point count changed; points can be moved but not added or removed.");
  }
  const out = new Uint8Array(original);
  const view = new DataView(out.buffer);

  // 1. Positions.
  points.forEach((p, i) => {
    const slot = parsed.slots[i];
    const lat = p.lat === null || p.lon === null ? INVALID_SINT32 : degreesToSemicircles(p.lat);
    const lon = p.lat === null || p.lon === null ? INVALID_SINT32 : degreesToSemicircles(p.lon);
    view.setInt32(slot.latOffset, lat, slot.littleEndian);
    view.setInt32(slot.lonOffset, lon, slot.littleEndian);
  });

  // 2. Record distance and speed.
  const changed = points.map(
    (p, i) => p.lat !== parsed.points[i].lat || p.lon !== parsed.points[i].lon,
  );
  // A step needs new speed if either of its ends moved (or lost its position).
  const touched = new Array<boolean>(points.length).fill(false);
  let lastValid = -1;
  let gapChanged = false; // did anything change since the last point with a position?
  points.forEach((p, i) => {
    if (changed[i]) gapChanged = true;
    if (p.lat !== null && p.lon !== null) {
      if (gapChanged || (lastValid >= 0 && changed[lastValid])) {
        for (let j = lastValid + 1; j <= i; j++) touched[j] = true;
      }
      lastValid = i;
      gapChanged = false;
    } else if (changed[i]) {
      touched[i] = true;
    }
  });
  if (!changed.some(Boolean)) {
    return finish(out, view, parsed);
  }

  // Each point's time in FIT seconds, so it lines up with record times.
  const pointTimes = new Array<number | null>(points.length).fill(null);
  for (const rec of parsed.records) if (rec.point >= 0) pointTimes[rec.point] = rec.time;

  // The file's own distance samples (some files keep them in separate records).
  const recorded: { t: number; d: number }[] = [];
  for (const rec of parsed.records) {
    if (rec.time === null || !rec.distance) continue;
    const cm = readSlot(view, rec.distance);
    if (cm !== null) recorded.push({ t: rec.time, d: cm / 100 });
  }
  recorded.sort((a, b) => a.t - b.t);
  const model = recorded.length
    ? buildDistanceModel(parsed.points, points, pointTimes, recorded)
    : null;

  const steps = stepDistances(points);
  const newSpeeds: { time: number | null; speed: number | null }[] = [];
  let lastDistance = 0;
  for (const rec of parsed.records) {
    if (model && rec.distance && rec.time !== null && readSlot(view, rec.distance) !== null) {
      // Never let distance go backwards.
      const metres = Math.max(lastDistance, model.fixedAt(rec.time));
      writeSlot(view, rec.distance, metres * 100);
      lastDistance = metres;
    }
    let speed: number | null = null; // m/s
    if (rec.point >= 0 && touched[rec.point]) {
      speed = speedAround(points, steps, rec.point);
      if (speed !== null) {
        if (rec.speed && readSlot(view, rec.speed) !== null) writeSlot(view, rec.speed, speed * 1000);
        if (rec.enhancedSpeed && readSlot(view, rec.enhancedSpeed) !== null)
          writeSlot(view, rec.enhancedSpeed, speed * 1000);
      }
    }
    if (speed === null) {
      const raw = rec.enhancedSpeed ? readSlot(view, rec.enhancedSpeed) : rec.speed ? readSlot(view, rec.speed) : null;
      speed = raw === null ? null : raw / 1000;
    }
    newSpeeds.push({ time: rec.time, speed });
  }

  // 3. Lap and session totals.
  const lastRecordTime = parsed.records.reduce((m, r) => (r.time !== null && r.time > m ? r.time : m), 0);
  for (const sum of parsed.summaries) {
    if (sum.startTime === null) continue;
    // Some files leave out a lap's end time; use the next lap's start, or the last record.
    const next = parsed.summaries.find(
      (o) => o.kind === sum.kind && o.startTime !== null && o.startTime > sum.startTime!,
    );
    const endTime = sum.endTime ?? (next ? next.startTime! - 1 : lastRecordTime);
    let totalM: number | null = null;
    if (sum.totalDistance && model) {
      const cm = readSlot(view, sum.totalDistance);
      if (cm !== null) {
        const startShift = model.fixedAt(sum.startTime) - model.originalAt(sum.startTime);
        const endShift = model.fixedAt(endTime) - model.originalAt(endTime);
        totalM = Math.max(0, cm / 100 + (endShift - startShift));
        writeSlot(view, sum.totalDistance, totalM * 100);
      }
    }
    if (totalM !== null && sum.timerTime) {
      const avg = totalM / sum.timerTime;
      if (sum.avgSpeed && readSlot(view, sum.avgSpeed) !== null) writeSlot(view, sum.avgSpeed, avg * 1000);
      if (sum.enhancedAvgSpeed && readSlot(view, sum.enhancedAvgSpeed) !== null)
        writeSlot(view, sum.enhancedAvgSpeed, avg * 1000);
    }
    const inLap = newSpeeds.filter(
      (r) => r.time !== null && r.speed !== null && r.time >= sum.startTime! && r.time <= endTime,
    );
    if (inLap.length) {
      const max = Math.max(...inLap.map((r) => r.speed!));
      if (sum.maxSpeed && readSlot(view, sum.maxSpeed) !== null) writeSlot(view, sum.maxSpeed, max * 1000);
      if (sum.enhancedMaxSpeed && readSlot(view, sum.enhancedMaxSpeed) !== null)
        writeSlot(view, sum.enhancedMaxSpeed, max * 1000);
    }
  }

  return finish(out, view, parsed);
}

/** Recalculates each FIT segment's checksum. */
function finish(out: Uint8Array, view: DataView, parsed: ParsedFit): Uint8Array {
  // 4. Checksums.
  for (const seg of parsed.segments) {
    const dataEnd = seg.start + seg.headerSize + seg.dataSize;
    view.setUint16(dataEnd, fitCrc(out, seg.start, dataEnd), true);
  }
  return out;
}

/**
 * Speed (m/s) at a point, from the fixed track: the distance from the
 * previous point with a position, divided by the time between them. Points
 * without a position get the speed of the step that spans their gap.
 */
function speedAround(points: TrackPoint[], steps: number[], i: number): number | null {
  // Find the step that covers point i: it ends at the next point with a position.
  let end = i;
  while (end < points.length && (points[end].lat === null || points[end].lon === null)) end++;
  if (end >= points.length) return null;
  let start = end - 1;
  while (start >= 0 && (points[start].lat === null || points[start].lon === null)) start--;
  if (start < 0) return null;
  const t0 = points[start].time;
  const t1 = points[end].time;
  if (t0 === null || t1 === null || t1 <= t0) return null;
  return steps[end] / ((t1 - t0) / 1000);
}

/**
 * Safety check: confirms that the only bytes that differ between the original
 * and the fixed file are positions, GPS-derived distance/speed values and
 * checksums, and that the fixed file's checksums are valid.
 * Returns a list of problems (empty means OK).
 */
export function verifyFit(original: Uint8Array, fixed: Uint8Array, parsed: ParsedFit): string[] {
  const problems: string[] = [];
  if (original.length !== fixed.length) {
    return ["The fixed file has a different size from the original."];
  }
  const allowed = new Uint8Array(original.length);
  const allow = (slot: Slot | undefined) => {
    if (slot) allowed.fill(1, slot.offset, slot.offset + slot.size);
  };
  for (const slot of parsed.slots) {
    allowed.fill(1, slot.latOffset, slot.latOffset + 4);
    allowed.fill(1, slot.lonOffset, slot.lonOffset + 4);
  }
  for (const rec of parsed.records) {
    allow(rec.distance);
    allow(rec.speed);
    allow(rec.enhancedSpeed);
  }
  for (const sum of parsed.summaries) {
    allow(sum.totalDistance);
    allow(sum.avgSpeed);
    allow(sum.maxSpeed);
    allow(sum.enhancedAvgSpeed);
    allow(sum.enhancedMaxSpeed);
  }
  for (const seg of parsed.segments) {
    const dataEnd = seg.start + seg.headerSize + seg.dataSize;
    allowed.fill(1, dataEnd, dataEnd + 2);
    const stored = fixed[dataEnd] | (fixed[dataEnd + 1] << 8);
    if (stored !== fitCrc(fixed, seg.start, dataEnd)) {
      problems.push("The fixed file's checksum is wrong.");
    }
  }
  for (let i = 0; i < original.length; i++) {
    if (original[i] !== fixed[i] && !allowed[i]) {
      problems.push(`Byte ${i} changed, but it isn't a GPS position, distance or speed.`);
      if (problems.length > 5) break;
    }
  }
  return problems;
}

/** Total distance in metres as the file reports it (session, else last record). */
export function reportedDistance(bytes: Uint8Array, parsed: ParsedFit): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Sessions cover the whole activity (several for multisport); fall back to laps.
  for (const kind of ["session", "lap"] as const) {
    let total: number | null = null;
    for (const sum of parsed.summaries) {
      const cm = sum.kind === kind && sum.totalDistance ? readSlot(view, sum.totalDistance) : null;
      if (cm !== null) total = (total ?? 0) + cm / 100;
    }
    if (total !== null) return total;
  }
  for (let i = parsed.records.length - 1; i >= 0; i--) {
    const slot = parsed.records[i].distance;
    const cm = slot ? readSlot(view, slot) : null;
    if (cm !== null) return cm / 100;
  }
  return null;
}
