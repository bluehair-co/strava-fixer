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
import { buildSegment, checksumProblems, concat, fitCrc, isFit, readMessages, walkFit, type RawMessage } from "./fitbytes";
import { stepDistances, type TrackPoint } from "./track";

export { fitCrc, isFit };

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

/** A new sample to add to the file, for a point added on the map. */
interface NewRecord {
  /** Index (into `parsed.points`) of the recorded point it comes after. */
  after: number;
  time: number; // FIT seconds
  lat: number;
  lon: number;
  distance: number | null; // metres
  speed: number | null; // m/s
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
 *
 * Points marked `added` become new samples (see `addRecords`) holding only a
 * time, a position, and distance/speed if the file's samples have those.
 */
export function writeFit(original: Uint8Array, parsed: ParsedFit, points: TrackPoint[]): Uint8Array {
  // `kept` maps each recorded point to its place in `points`.
  const kept: number[] = [];
  points.forEach((p, j) => {
    if (!p.added) kept.push(j);
  });
  if (kept.length !== parsed.slots.length) {
    throw new Error("Point count changed; recorded points can be moved but not removed.");
  }
  const out = new Uint8Array(original);
  const view = new DataView(out.buffer);

  // 1. Positions.
  kept.forEach((j, i) => {
    const p = points[j];
    const slot = parsed.slots[i];
    const lat = p.lat === null || p.lon === null ? INVALID_SINT32 : degreesToSemicircles(p.lat);
    const lon = p.lat === null || p.lon === null ? INVALID_SINT32 : degreesToSemicircles(p.lon);
    view.setInt32(slot.latOffset, lat, slot.littleEndian);
    view.setInt32(slot.lonOffset, lon, slot.littleEndian);
  });

  // 2. Record distance and speed.
  // What each point was in the file; added points count as "had no position".
  const before: TrackPoint[] = points.map((p) => ({ lat: null, lon: null, time: p.time }));
  kept.forEach((j, i) => (before[j] = parsed.points[i]));
  const changed = points.map((p, j) => p.lat !== before[j].lat || p.lon !== before[j].lon);
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
  for (const rec of parsed.records) if (rec.point >= 0) pointTimes[kept[rec.point]] = rec.time;
  points.forEach((p, j) => {
    if (!p.added) return;
    if (p.time === null || p.lat === null || p.lon === null) {
      throw new Error("An added point has no time, because the points around it have no time or position.");
    }
    pointTimes[j] = Math.round((p.time - FIT_EPOCH_MS) / 1000);
  });

  // The file's own distance samples (some files keep them in separate records).
  const recorded: { t: number; d: number }[] = [];
  for (const rec of parsed.records) {
    if (rec.time === null || !rec.distance) continue;
    const cm = readSlot(view, rec.distance);
    if (cm !== null) recorded.push({ t: rec.time, d: cm / 100 });
  }
  recorded.sort((a, b) => a.t - b.t);
  const model = recorded.length
    ? buildDistanceModel(before, points, pointTimes, recorded)
    : null;

  const steps = stepDistances(points);
  const newSpeeds: { time: number | null; speed: number | null }[] = [];
  const written: { t: number; m: number }[] = [];
  let lastDistance = 0;
  for (const rec of parsed.records) {
    if (model && rec.distance && rec.time !== null && readSlot(view, rec.distance) !== null) {
      // Never let distance go backwards.
      const metres = Math.max(lastDistance, model.fixedAt(rec.time));
      writeSlot(view, rec.distance, metres * 100);
      lastDistance = metres;
      written.push({ t: rec.time, m: metres });
    }
    let speed: number | null = null; // m/s
    const j = rec.point >= 0 ? kept[rec.point] : -1;
    if (j >= 0 && touched[j]) {
      speed = speedAround(points, steps, j);
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

  // Values for the new samples of added points.
  const newRecords: NewRecord[] = [];
  let after = -1;
  points.forEach((p, j) => {
    if (!p.added) {
      after++;
      return;
    }
    const t = pointTimes[j]!;
    let distance: number | null = null;
    if (model) {
      // Not less than any distance already written at or before this time.
      const floor = written.reduce((m, w) => (w.t <= t && w.m > m ? w.m : m), 0);
      distance = Math.max(floor, model.fixedAt(t));
    }
    const speed = speedAround(points, steps, j);
    newRecords.push({ after, time: t, lat: p.lat!, lon: p.lon!, distance, speed });
    newSpeeds.push({ time: t, speed });
  });

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

  const done = finish(out, view, parsed);
  return newRecords.length ? addRecords(done, parsed, newRecords) : done;
}

/** Local message number used for added samples (restored afterwards). */
const NEW_RECORD_LOCAL = 15;

/**
 * Puts new samples into the file. Each goes after the sample of the recorded
 * point before it, just before the first later message with a later time, so
 * the file stays in time order. Every existing message stays as it was.
 *
 * A new sample has a timestamp and a position, plus distance and speed if
 * the file's samples have those. Heart rate, cadence, power, temperature,
 * elevation and so on are left out: they weren't measured at that moment, and
 * we don't make up sensor data.
 */
function addRecords(bytes: Uint8Array, parsed: ParsedFit, adds: NewRecord[]): Uint8Array {
  const hasDistance = parsed.records.some((r) => r.distance);
  const hasSpeed = parsed.records.some((r) => r.speed);
  const hasEnhancedSpeed = parsed.records.some((r) => r.enhancedSpeed);
  // [field number, size, FIT base type]
  const fields: [number, number, number][] = [
    [FIELD_TIMESTAMP, 4, 0x86],
    [FIELD_LAT, 4, 0x85],
    [FIELD_LON, 4, 0x85],
  ];
  if (hasDistance) fields.push([RECORD_FIELDS.distance, 4, 0x86]);
  if (hasSpeed) fields.push([RECORD_FIELDS.speed, 2, 0x84]);
  if (hasEnhancedSpeed) fields.push([RECORD_FIELDS.enhancedSpeed, 4, 0x86]);
  const definition = new Uint8Array([
    0x40 | NEW_RECORD_LOCAL, 0, 0 /* little-endian */, RECORD_MESG & 0xff, RECORD_MESG >> 8,
    fields.length, ...fields.flat(),
  ]);
  const encode = (r: NewRecord) => {
    const msg = new Uint8Array(1 + fields.reduce((n, f) => n + f[1], 0));
    const v = new DataView(msg.buffer);
    msg[0] = NEW_RECORD_LOCAL;
    v.setUint32(1, r.time, true);
    v.setInt32(5, degreesToSemicircles(r.lat), true);
    v.setInt32(9, degreesToSemicircles(r.lon), true);
    let at = 13;
    const clamp = (x: number, max: number) => Math.min(max - 1, Math.max(0, Math.round(x)));
    if (hasDistance) {
      v.setUint32(at, r.distance === null ? INVALID_UINT32 : clamp(r.distance * 100, INVALID_UINT32), true);
      at += 4;
    }
    if (hasSpeed) {
      v.setUint16(at, r.speed === null ? INVALID_UINT16 : clamp(r.speed * 1000, INVALID_UINT16), true);
      at += 2;
    }
    if (hasEnhancedSpeed) {
      v.setUint32(at, r.speed === null ? INVALID_UINT32 : clamp(r.speed * 1000, INVALID_UINT32), true);
    }
    return msg;
  };

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const segments: Uint8Array[] = [];
  let header: Uint8Array | null = null;
  let chunks: Uint8Array[] = [];
  let next = 0; // next sample to add
  let pointsSeen = 0; // recorded points passed so far
  let lastTimestamp = 0;
  // The file's own definition for our local message number, to put back.
  let localDef: Uint8Array | null = null;

  // Adds the waiting samples that belong before a message with time `t`
  // (null: no time) that is recorded point `point` (-1: not a point).
  const flush = (t: number | null, point: number) => {
    const batch: Uint8Array[] = [];
    while (
      next < adds.length &&
      adds[next].after < pointsSeen &&
      (point === adds[next].after + 1 || point === Infinity || (t !== null && t > adds[next].time))
    ) {
      batch.push(encode(adds[next++]));
    }
    if (batch.length) chunks.push(definition, ...batch, ...(localDef ? [localDef] : []));
  };

  walkFit(bytes, {
    segment(seg) {
      header = bytes.slice(seg.start, seg.start + seg.headerSize);
      chunks = [];
      localDef = null;
      lastTimestamp = 0;
    },
    definition(_def, localType, start, end) {
      chunks.push(bytes.subarray(start, end));
      if (localType === NEW_RECORD_LOCAL) localDef = bytes.subarray(start, end);
    },
    data(def, start, end) {
      // This message's time, as in parseFit.
      let t: number | null = null;
      let pos = start + 1;
      for (const f of def.fields) {
        if (f.num === FIELD_TIMESTAMP && f.size === 4) t = view.getUint32(pos, def.littleEndian);
        pos += f.size;
      }
      if (t !== null) {
        lastTimestamp = t;
      } else if (bytes[start] & 0x80) {
        const offset = bytes[start] & 0x1f;
        const base = lastTimestamp & ~0x1f;
        t = offset >= (lastTimestamp & 0x1f) ? base + offset : base + offset + 0x20;
        lastTimestamp = t;
      }
      const isPoint =
        def.globalNum === RECORD_MESG &&
        def.fields.some((f) => f.num === FIELD_LAT && f.size === 4) &&
        def.fields.some((f) => f.num === FIELD_LON && f.size === 4);
      flush(t, isPoint ? pointsSeen : -1);
      chunks.push(bytes.subarray(start, end));
      if (isPoint) pointsSeen++;
      // Our samples carry a full timestamp, which later compressed timestamps
      // count from; since they're never later than the next message, that's fine.
    },
    segmentEnd() {
      flush(null, Infinity);
      segments.push(buildSegment(header!, chunks));
    },
  });
  if (next < adds.length) throw new Error("Couldn't find where to put an added point in the file.");
  return concat(segments);
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
 *
 * `added` is how many points were added on the map: then the file has new
 * samples, so it's compared message by message instead (see below).
 */
export function verifyFit(original: Uint8Array, fixed: Uint8Array, parsed: ParsedFit, added = 0): string[] {
  if (added > 0) return verifyFitWithAdded(original, fixed, added);
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

/** Fields a new sample for an added point may have. */
const NEW_RECORD_FIELDS = new Set<number>([FIELD_TIMESTAMP, FIELD_LAT, FIELD_LON, ...Object.values(RECORD_FIELDS)]);

/**
 * Safety check for a file with added points. Every message of the original
 * must still be there, in the same order, with every value identical except
 * positions, distance and speed. The only new messages allowed are exactly
 * `added` samples holding nothing but a time, a position, distance and speed
 * (so no heart rate, power etc. was made up).
 */
function verifyFitWithAdded(original: Uint8Array, fixed: Uint8Array, added: number): string[] {
  let a: RawMessage[];
  let b: RawMessage[];
  try {
    a = readMessages(original);
    b = readMessages(fixed);
  } catch {
    return ["The fixed file can't be read back."];
  }
  const problems = checksumProblems(fixed, "fixed");
  const changeable = new Map<number, Set<number>>([
    [RECORD_MESG, new Set([FIELD_LAT, FIELD_LON, ...Object.values(RECORD_FIELDS)])],
    ...[LAP_MESG, SESSION_MESG].map((m) => {
      const { totalDistance, avgSpeed, maxSpeed, enhancedAvgSpeed, enhancedMaxSpeed } = SUMMARY_FIELDS[m as 18 | 19];
      return [m, new Set([totalDistance, avgSpeed, maxSpeed, enhancedAvgSpeed, enhancedMaxSpeed])] as [number, Set<number>];
    }),
  ]);
  const same = (x: RawMessage, y: RawMessage) => {
    if (x.globalNum !== y.globalNum || x.header !== y.header || x.dev !== y.dev) return false;
    if (x.fields.size !== y.fields.size) return false;
    const allowed = changeable.get(x.globalNum);
    for (const [num, value] of x.fields) {
      if (!y.fields.has(num)) return false;
      if (y.fields.get(num) !== value && !allowed?.has(num)) return false;
    }
    return true;
  };
  const isNewSample = (y: RawMessage) =>
    y.globalNum === RECORD_MESG &&
    y.header === 0 &&
    y.dev === "" &&
    [FIELD_TIMESTAMP, FIELD_LAT, FIELD_LON].every((n) => y.fields.has(n)) &&
    [...y.fields.keys()].every((n) => NEW_RECORD_FIELDS.has(n));

  let i = 0;
  let extra = 0;
  for (const y of b) {
    if (i < a.length && same(a[i], y)) i++;
    else if (isNewSample(y)) extra++;
    else {
      problems.push(`Message ${i + 1} of the original changed, or something other than a new GPS point was added.`);
      return problems;
    }
  }
  if (i < a.length) problems.push("Some messages of the original are missing from the fixed file.");
  if (extra !== added) problems.push(`The fixed file has ${extra} new points, but ${added} were added.`);
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
