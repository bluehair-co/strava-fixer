/**
 * Low-level helpers for reading FIT files message by message, shared by the
 * editor, merging and joining.
 */

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

/* ---------- Reading FIT messages generically ---------- */

interface FieldDef {
  num: number;
  size: number;
  /** Byte offset of this field's definition (num, size, type) in the file. */
  defOffset: number;
}

export interface MesgDef {
  globalNum: number;
  littleEndian: boolean;
  /** Byte offset of the definition's "number of fields" byte. */
  countOffset: number;
  fields: FieldDef[];
  fieldsSize: number;
  devFieldsSize: number;
}

interface FitSegmentInfo {
  start: number;
  headerSize: number;
  dataEnd: number;
}

interface Visitor {
  segment?(seg: FitSegmentInfo): void;
  /** A definition message, from `start` up to (not including) `end`. */
  definition?(def: MesgDef, localType: number, start: number, end: number): void;
  /** A data message: header byte at `start`, fields from `start + 1`. */
  data?(def: MesgDef, start: number, end: number): void;
  segmentEnd?(seg: FitSegmentInfo): void;
}

/** Walks every message of a FIT file (all segments), calling the visitor. */
export function walkFit(bytes: Uint8Array, visit: Visitor) {
  if (!isFit(bytes)) throw new Error("This doesn't look like a FIT file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let segStart = 0;
  while (segStart + 12 <= bytes.length && isFit(bytes.subarray(segStart))) {
    const headerSize = bytes[segStart];
    const dataEnd = segStart + headerSize + view.getUint32(segStart + 4, true);
    if (dataEnd + 2 > bytes.length) {
      throw new Error("The FIT file is shorter than its header says. Is it complete?");
    }
    const seg = { start: segStart, headerSize, dataEnd };
    visit.segment?.(seg);
    const defs = new Map<number, MesgDef>();
    let pos = segStart + headerSize;
    while (pos < dataEnd) {
      const start = pos;
      const header = bytes[pos++];
      if (!(header & 0x80) && header & 0x40) {
        const localType = header & 0x0f;
        const littleEndian = bytes[pos + 1] === 0;
        const globalNum = view.getUint16(pos + 2, littleEndian);
        const countOffset = pos + 4;
        const numFields = bytes[countOffset];
        pos += 5;
        const fields: FieldDef[] = [];
        let fieldsSize = 0;
        for (let i = 0; i < numFields; i++) {
          fields.push({ num: bytes[pos], size: bytes[pos + 1], defOffset: pos });
          fieldsSize += bytes[pos + 1];
          pos += 3;
        }
        let devFieldsSize = 0;
        if (header & 0x20) {
          const numDev = bytes[pos++];
          for (let i = 0; i < numDev; i++) {
            devFieldsSize += bytes[pos + 1];
            pos += 3;
          }
        }
        const def = { globalNum, littleEndian, countOffset, fields, fieldsSize, devFieldsSize };
        defs.set(localType, def);
        visit.definition?.(def, localType, start, pos);
        continue;
      }
      const localType = header & 0x80 ? (header >> 5) & 0x03 : header & 0x0f;
      const def = defs.get(localType);
      if (!def) {
        throw new Error(`The FIT file uses a message type before defining it (at byte ${start}).`);
      }
      pos += def.fieldsSize + def.devFieldsSize;
      visit.data?.(def, start, pos);
    }
    visit.segmentEnd?.(seg);
    segStart = dataEnd + 2;
  }
}

/** One data message as raw bytes per field, for comparing two files. */
export interface RawMessage {
  globalNum: number;
  header: number;
  fields: Map<number, string>;
  dev: string;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function readMessages(bytes: Uint8Array): RawMessage[] {
  const out: RawMessage[] = [];
  walkFit(bytes, {
    data(def, start) {
      const fields = new Map<number, string>();
      let pos = start + 1;
      for (const f of def.fields) {
        // Bytes are compared in big-endian order so a field means the same
        // thing whichever byte order the file uses.
        const raw = bytes.slice(pos, pos + f.size);
        fields.set(f.num, hex(def.littleEndian ? raw.reverse() : raw));
        pos += f.size;
      }
      out.push({
        globalNum: def.globalNum,
        header: bytes[start] & 0x80 ? bytes[start] & 0x9f : 0, // keep compressed time offsets
        fields,
        dev: hex(bytes.subarray(pos, pos + def.devFieldsSize)),
      });
    },
  });
  return out;
}

/** Glues byte arrays together. */
export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Builds one FIT segment from its header and message bytes: fixes the data
 * size (and the header's own checksum, if it has one) and appends the
 * segment checksum.
 */
export function buildSegment(header: Uint8Array, chunks: Uint8Array[]): Uint8Array {
  const head = new Uint8Array(header);
  const dataSize = chunks.reduce((n, c) => n + c.length, 0);
  new DataView(head.buffer).setUint32(4, dataSize, true);
  // A 14-byte header has its own checksum (0 means "not used").
  if (head.length >= 14 && (head[12] || head[13])) {
    const crc = fitCrc(head, 0, 12);
    head[12] = crc & 0xff;
    head[13] = crc >> 8;
  }
  const seg = concat([head, ...chunks]);
  const crc = fitCrc(seg, 0, seg.length);
  return concat([seg, new Uint8Array([crc & 0xff, crc >> 8])]);
}

/** Problems with the checksums of a FIT file (empty means OK). */
export function checksumProblems(bytes: Uint8Array, what: string): string[] {
  const problems: string[] = [];
  walkFit(bytes, {
    segmentEnd(seg) {
      const stored = bytes[seg.dataEnd] | (bytes[seg.dataEnd + 1] << 8);
      if (stored !== fitCrc(bytes, seg.start, seg.dataEnd)) problems.push(`The ${what} file's checksum is wrong.`);
    },
  });
  return problems;
}
