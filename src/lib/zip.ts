/**
 * Reading and writing .zip files in the browser, with nothing uploaded.
 *
 * Reading only looks at the zip's table of contents at first, and unpacks a
 * file when you ask for it, so even a Strava export of several gigabytes
 * (photos and all) opens quickly without loading it all into memory.
 * Writing stores files as they are (no compression), which is all we need
 * for handing activity files back.
 */

export interface ZipEntry {
  /** Path inside the zip, e.g. "activities/123.fit.gz". */
  name: string;
  size: number;
  dir: boolean;
  /** Unpacks this file. */
  read(): Promise<Uint8Array>;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function slice(blob: Blob, start: number, end: number): Promise<DataView> {
  const buf = await blob.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Lists the files in a zip. Throws if it isn't a zip. */
export async function readZip(blob: Blob): Promise<ZipEntry[]> {
  // The "end of central directory" record is in the last 22 bytes, plus up to 64 KB of comment.
  const tailStart = Math.max(0, blob.size - 22 - 65535);
  const tail = await slice(blob, tailStart, blob.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This doesn't look like a .zip file.");
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  // Big zips (over 4 GB or 65535 files) keep the real numbers in a "zip64" record.
  if (eocd >= 20 && tail.getUint32(eocd - 20, true) === ZIP64_LOCATOR) {
    const at = Number(tail.getBigUint64(eocd - 20 + 8, true));
    const z = await slice(blob, at, at + 56);
    if (z.getUint32(0, true) === ZIP64_EOCD) {
      count = Number(z.getBigUint64(32, true));
      cdSize = Number(z.getBigUint64(40, true));
      cdOffset = Number(z.getBigUint64(48, true));
    }
  }
  const cd = await slice(blob, cdOffset, cdOffset + cdSize);
  const names = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.byteLength; n++) {
    if (cd.getUint32(p, true) !== CENTRAL) break;
    const method = cd.getUint16(p + 10, true);
    let compressed = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let offset = cd.getUint32(p + 42, true);
    const name = names.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    // Zip64 extra field: holds whichever of the sizes/offset didn't fit.
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) {
          size = Number(cd.getBigUint64(q, true));
          q += 8;
        }
        if (compressed === 0xffffffff) {
          compressed = Number(cd.getBigUint64(q, true));
          q += 8;
        }
        if (offset === 0xffffffff) offset = Number(cd.getBigUint64(q, true));
      }
      e += 4 + len;
    }
    p = extraEnd + commentLen;
    const dir = name.endsWith("/");
    entries.push({
      name,
      size,
      dir,
      async read() {
        const head = await slice(blob, offset, offset + 30);
        if (head.getUint32(0, true) !== LOCAL) throw new Error(`${name}: damaged zip entry.`);
        const start = offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
        const raw = new Uint8Array(await blob.slice(start, start + compressed).arrayBuffer());
        if (method === 0) return raw;
        if (method === 8) return inflateRaw(raw);
        throw new Error(`${name}: this zip uses a compression method the browser can't unpack.`);
      },
    });
  }
  return entries;
}

/* ---------- Writing ---------- */

let crcTable: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a zip holding these files, stored without compression. */
export function writeZip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // names are UTF-8
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, CENTRAL, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, f.data);
    centrals.push(central);
    offset += local.length + f.data.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, EOCD, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
