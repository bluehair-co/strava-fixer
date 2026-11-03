/**
 * Minimal FIT file reader/writer that only ever touches GPS positions.
 *
 * Instead of decoding the file into objects and re-encoding it (which can
 * silently drop fields the encoder doesn't know about), we walk the raw bytes,
 * remember exactly where each record's latitude and longitude are stored, and
 * later overwrite just those bytes. Every other byte of the file stays
 * identical, apart from the 2-byte checksum at the end of each FIT segment,
 * which has to be recalculated because the data changed.
 *
 * FIT format reference: https://developer.garmin.com/fit/protocol/
 */

import type { TrackPoint } from "./track";

const RECORD_MESG = 20; // "record" messages hold one sample (position, HR, ...)
const FIELD_LAT = 0; // position_lat, sint32 semicircles
const FIELD_LON = 1; // position_long, sint32 semicircles
const FIELD_TIMESTAMP = 253; // uint32 seconds since FIT epoch
const INVALID_SINT32 = 0x7fffffff; // FIT's "no value" marker for sint32
const FIT_EPOCH_MS = Date.UTC(1989, 11, 31, 0, 0, 0);
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

export interface ParsedFit {
  points: TrackPoint[];
  slots: FitPositionSlot[];
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

      let latOffset = -1;
      let lonOffset = -1;
      let timestamp: number | null = null;
      for (const field of def.fields) {
        if (field.num === FIELD_TIMESTAMP && field.size === 4) {
          timestamp = view.getUint32(pos, def.littleEndian);
        } else if (def.globalNum === RECORD_MESG && field.size === 4) {
          if (field.num === FIELD_LAT) latOffset = pos;
          if (field.num === FIELD_LON) lonOffset = pos;
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

      if (latOffset >= 0 && lonOffset >= 0) {
        const lat = view.getInt32(latOffset, def.littleEndian);
        const lon = view.getInt32(lonOffset, def.littleEndian);
        const valid = lat !== INVALID_SINT32 && lon !== INVALID_SINT32;
        points.push({
          lat: valid ? semicirclesToDegrees(lat) : null,
          lon: valid ? semicirclesToDegrees(lon) : null,
          time: timestamp !== null ? FIT_EPOCH_MS + timestamp * 1000 : null,
        });
        slots.push({ latOffset, lonOffset, littleEndian: def.littleEndian });
      }
    }
    segStart = dataEnd + 2;
  }

  if (segments.length === 0) throw new Error("This doesn't look like a FIT file.");
  return { points, slots, segments };
}

/**
 * Returns a copy of the original file with only the positions replaced.
 * A point with lat/lon of null is written as "no position" (FIT's invalid value).
 */
export function writeFit(original: Uint8Array, parsed: ParsedFit, points: TrackPoint[]): Uint8Array {
  if (points.length !== parsed.slots.length) {
    throw new Error("Point count changed; points can be moved but not added or removed.");
  }
  const out = new Uint8Array(original);
  const view = new DataView(out.buffer);
  points.forEach((p, i) => {
    const slot = parsed.slots[i];
    const lat = p.lat === null || p.lon === null ? INVALID_SINT32 : degreesToSemicircles(p.lat);
    const lon = p.lat === null || p.lon === null ? INVALID_SINT32 : degreesToSemicircles(p.lon);
    view.setInt32(slot.latOffset, lat, slot.littleEndian);
    view.setInt32(slot.lonOffset, lon, slot.littleEndian);
  });
  for (const seg of parsed.segments) {
    const dataEnd = seg.start + seg.headerSize + seg.dataSize;
    view.setUint16(dataEnd, fitCrc(out, seg.start, dataEnd), true);
  }
  return out;
}

/**
 * Safety check: confirms that the only bytes that differ between the original
 * and the fixed file are position fields and checksums, and that the fixed
 * file's checksums are valid. Returns a list of problems (empty means OK).
 */
export function verifyFit(original: Uint8Array, fixed: Uint8Array, parsed: ParsedFit): string[] {
  const problems: string[] = [];
  if (original.length !== fixed.length) {
    return ["The fixed file has a different size from the original."];
  }
  const allowed = new Uint8Array(original.length);
  for (const slot of parsed.slots) {
    allowed.fill(1, slot.latOffset, slot.latOffset + 4);
    allowed.fill(1, slot.lonOffset, slot.lonOffset + 4);
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
      problems.push(`Byte ${i} changed, but it isn't part of a GPS position.`);
      if (problems.length > 5) break;
    }
  }
  return problems;
}
