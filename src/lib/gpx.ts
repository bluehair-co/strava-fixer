/**
 * GPX support that only ever touches the lat="..." and lon="..." attributes
 * of track points. We edit the original text in place rather than parsing
 * and re-serialising the XML, so heart rate, cadence, power, elevation,
 * extensions, comments and even whitespace stay exactly as they were.
 *
 * Points added on the map become new, minimal track points with just a
 * position and a time, inserted after the recorded point before them.
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
  /** Where each track point element starts and ends in the text. */
  spans: GpxAttr[];
  /** Namespace prefix of the track point tags, e.g. "" or "gpx:". */
  prefix: string;
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
  const spans: GpxAttr[] = [];
  const tags = [...text.matchAll(TRKPT)];
  const prefix = tags.length ? /^<([\w-]+:)?/.exec(tags[0][0])![1] ?? "" : "";
  tags.forEach((m, i) => {
    const tagStart = m.index!;
    const lat = findAttr(m[0], tagStart, "lat");
    const lon = findAttr(m[0], tagStart, "lon");
    if (!lat || !lon) return;
    const bodyEnd = i + 1 < tags.length ? tags[i + 1].index! : text.length;
    const body = text.slice(tagStart + m[0].length, bodyEnd);
    const close = /<\/(?:[\w-]+:)?trkpt\s*>/.exec(body);
    const closeAt = close ? close.index : -1;
    const timeMatch = TIME.exec(closeAt >= 0 ? body.slice(0, closeAt) : body);
    const time = timeMatch ? Date.parse(timeMatch[1]) : NaN;
    points.push({
      lat: Number(text.slice(lat.start, lat.end)),
      lon: Number(text.slice(lon.start, lon.end)),
      time: Number.isNaN(time) ? null : time,
    });
    lats.push(lat);
    lons.push(lon);
    const tagEnd = tagStart + m[0].length;
    spans.push({ start: tagStart, end: m[0].endsWith("/>") || !close ? tagEnd : tagEnd + close.index + close[0].length });
  });
  if (points.length === 0) throw new Error("The GPX file has no track points.");
  return { points, lats, lons, spans, prefix };
}

function formatCoord(value: number): string {
  // 7 decimal places is about 1 cm, more precise than any GPS.
  return value.toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.000Z$/, "Z");
}

/** The text of a track point for a point added on the map. */
export function newTrackPoint(prefix: string, p: TrackPoint): string {
  const time = p.time === null ? "" : `<${prefix}time>${formatTime(p.time)}</${prefix}time>`;
  return `<${prefix}trkpt lat="${formatCoord(p.lat!)}" lon="${formatCoord(p.lon!)}">${time}</${prefix}trkpt>`;
}

export function writeGpx(original: string, parsed: ParsedGpx, points: TrackPoint[]): string {
  if (points.filter((p) => !p.added).length !== parsed.points.length) {
    throw new Error("Point count changed; recorded points can be moved but not removed.");
  }
  const edits: { start: number; end: number; text: string }[] = [];
  let i = -1; // the recorded point we're at
  points.forEach((p) => {
    if (p.added) {
      if (i < 0 || p.lat === null || p.lon === null) throw new Error("An added point needs a position and a point before it.");
      // Same line break and indent as the point before it.
      const span = parsed.spans[i];
      const indent = /\s*$/.exec(original.slice(Math.max(0, span.start - 200), span.start))![0];
      edits.push({ start: span.end, end: span.end, text: indent + newTrackPoint(parsed.prefix, p) });
      return;
    }
    i++;
    const before = parsed.points[i];
    if (p.lat === before.lat && p.lon === before.lon) return; // untouched: keep original text
    if (p.lat === null || p.lon === null) {
      throw new Error("GPX track points must have a position, so positions can't be removed.");
    }
    edits.push({ ...parsed.lats[i], text: formatCoord(p.lat) });
    edits.push({ ...parsed.lons[i], text: formatCoord(p.lon) });
  });
  // Stable sort keeps added points in order.
  edits.sort((x, y) => x.start - y.start);
  let out = "";
  let cursor = 0;
  for (const e of edits) {
    out += original.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + original.slice(cursor);
}

/**
 * Confirms that only lat/lon values differ. Returns problems (empty means OK).
 *
 * If points were added (`points` is the edited track), each added point must
 * be a minimal track point (position and time only) in the right place; they
 * are taken out again before comparing the rest with the original.
 */
export function verifyGpx(original: string, fixed: string, parsed: ParsedGpx, points?: TrackPoint[]): string[] {
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
  const added = points?.filter((p) => p.added).length ?? 0;
  if (added > 0) {
    if (reparsed.points.length !== points!.length) {
      return ["The fixed file has a different number of points."];
    }
    // Cut the added points (and the line break before each) back out.
    const NEW_POINT = /^<([\w-]+:)?trkpt lat="-?[\d.]+" lon="-?[\d.]+">(<\1time>[^<]+<\/\1time>)?<\/\1trkpt>$/;
    let stripped = "";
    let cursor = 0;
    for (let j = 0; j < points!.length; j++) {
      if (!points![j].added) continue;
      const span = reparsed.spans[j];
      if (!NEW_POINT.test(fixed.slice(span.start, span.end))) {
        return ["An added point holds more than a position and a time."];
      }
      const lead = /\s*$/.exec(fixed.slice(cursor, span.start))![0].length;
      stripped += fixed.slice(cursor, span.start - lead);
      cursor = span.end;
    }
    fixed = stripped + fixed.slice(cursor);
    try {
      reparsed = parseGpx(fixed);
    } catch {
      return ["The fixed file can't be read back."];
    }
  }
  if (reparsed.points.length !== parsed.points.length) {
    return ["The fixed file has a different number of points."];
  }
  return mask(original, parsed) === mask(fixed, reparsed)
    ? []
    : ["Something other than a GPS position changed in the fixed file."];
}
