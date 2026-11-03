/**
 * GPX support that only ever touches the lat="..." and lon="..." attributes
 * of track points. We edit the original text in place rather than parsing
 * and re-serialising the XML, so heart rate, cadence, power, elevation,
 * extensions, comments and even whitespace stay exactly as they were.
 */

import type { TrackPoint } from "./track";

export interface GpxAttr {
  /** Position of the attribute's value in the original text. */
  start: number;
  end: number;
}

export interface ParsedGpx {
  points: TrackPoint[];
  lats: GpxAttr[];
  lons: GpxAttr[];
}

const TRKPT = /<(?:[\w-]+:)?trkpt\b[^>]*>/g;
const TIME = /<(?:[\w-]+:)?time>\s*([^<\s]+)\s*</;

function findAttr(tag: string, tagStart: number, name: string): GpxAttr | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(["'])([^"']*)\\1`).exec(tag);
  if (!m) return null;
  const start = tagStart + m.index + m[0].length - 1 - m[2].length;
  return { start, end: start + m[2].length };
}

export function isGpx(text: string): boolean {
  return /<gpx[\s>]/.test(text.slice(0, 2000));
}

export function parseGpx(text: string): ParsedGpx {
  if (!isGpx(text)) throw new Error("This doesn't look like a GPX file.");
  const points: TrackPoint[] = [];
  const lats: GpxAttr[] = [];
  const lons: GpxAttr[] = [];
  const tags = [...text.matchAll(TRKPT)];
  tags.forEach((m, i) => {
    const tagStart = m.index!;
    const lat = findAttr(m[0], tagStart, "lat");
    const lon = findAttr(m[0], tagStart, "lon");
    if (!lat || !lon) return;
    const bodyEnd = i + 1 < tags.length ? tags[i + 1].index! : text.length;
    const body = text.slice(tagStart + m[0].length, bodyEnd);
    const closeAt = body.search(/<\/(?:[\w-]+:)?trkpt>/);
    const timeMatch = TIME.exec(closeAt >= 0 ? body.slice(0, closeAt) : body);
    const time = timeMatch ? Date.parse(timeMatch[1]) : NaN;
    points.push({
      lat: Number(text.slice(lat.start, lat.end)),
      lon: Number(text.slice(lon.start, lon.end)),
      time: Number.isNaN(time) ? null : time,
    });
    lats.push(lat);
    lons.push(lon);
  });
  if (points.length === 0) throw new Error("The GPX file has no track points.");
  return { points, lats, lons };
}

function formatCoord(value: number): string {
  // 7 decimal places is about 1 cm, more precise than any GPS.
  return value.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
}

export function writeGpx(original: string, parsed: ParsedGpx, points: TrackPoint[]): string {
  if (points.length !== parsed.points.length) {
    throw new Error("Point count changed; points can be moved but not added or removed.");
  }
  const edits: { start: number; end: number; text: string }[] = [];
  points.forEach((p, i) => {
    const before = parsed.points[i];
    if (p.lat === before.lat && p.lon === before.lon) return; // untouched: keep original text
    if (p.lat === null || p.lon === null) {
      throw new Error("GPX track points must have a position, so positions can't be removed.");
    }
    edits.push({ ...parsed.lats[i], text: formatCoord(p.lat) });
    edits.push({ ...parsed.lons[i], text: formatCoord(p.lon) });
  });
  edits.sort((x, y) => x.start - y.start);
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    out += original.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + original.slice(cursor);
}

/** Confirms that only lat/lon values differ. Returns problems (empty means OK). */
export function verifyGpx(original: string, fixed: string, parsed: ParsedGpx): string[] {
  const mask = (text: string, p: ParsedGpx) => {
    const ranges = [...p.lats, ...p.lons].sort((x, y) => x.start - y.start);
    let out = "";
    let cursor = 0;
    for (const r of ranges) {
      out += text.slice(cursor, r.start) + "#";
      cursor = r.end;
    }
    return out + text.slice(cursor);
  };
  let reparsed: ParsedGpx;
  try {
    reparsed = parseGpx(fixed);
  } catch {
    return ["The fixed file can't be read back."];
  }
  if (reparsed.points.length !== parsed.points.length) {
    return ["The fixed file has a different number of points."];
  }
  return mask(original, parsed) === mask(fixed, reparsed)
    ? []
    : ["Something other than a GPS position changed in the fixed file."];
}
