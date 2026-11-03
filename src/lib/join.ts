/**
 * Joining two recordings that happened one after the other, e.g. a watch
 * whose battery died and a phone that recorded the rest.
 *
 * Every sample of both files is kept exactly as recorded, in time order. The
 * only value that changes is the running distance of the second part: it
 * restarts at 0 in its own file, so we add the first part's final distance
 * (plus the straight line between where the first part ended and the second
 * began). The gap between the two shows up as a pause.
 *
 * `verifyJoinedFit` / `verifyJoinedGpx` check that the joined file holds
 * exactly the messages (or track points) of both files and nothing else
 * changed.
 */

import { parseFit, RECORD_FIELDS, RECORD_MESG } from "./fit";
import { isGpx, parseGpx } from "./gpx";
import { buildSegment, checksumProblems, isFit, readMessages, walkFit, type RawMessage } from "./fitbytes";
import { metresBetween, type TrackPoint } from "./track";

const FILE_ID_MESG = 0;
const INVALID_UINT32 = 0xffffffff;

export interface JoinResult {
  kind: "fit" | "gpx";
  data: Uint8Array;
  /** The joined track. */
  points: TrackPoint[];
  /** Which input file came first (0 or 1). */
  firstIndex: 0 | 1;
  /** Minutes between the end of the first part and the start of the second. */
  gapMinutes: number;
  problems: string[];
}

interface Part {
  bytes: Uint8Array;
  points: TrackPoint[];
  start: number;
  end: number;
}

function times(points: TrackPoint[]): number[] {
  return points.map((p) => p.time).filter((t): t is number => t !== null);
}

function lastPosition(points: TrackPoint[], fromEnd: boolean): { lat: number; lon: number } | null {
  const list = fromEnd ? [...points].reverse() : points;
  const p = list.find((q) => q.lat !== null && q.lon !== null);
  return p ? { lat: p.lat!, lon: p.lon! } : null;
}

/** Puts two recordings of one activity, made one after the other, into one file. */
export function joinActivities(fileA: Uint8Array, fileB: Uint8Array): JoinResult {
  const fit = isFit(fileA) && isFit(fileB);
  const textA = fit ? "" : new TextDecoder().decode(fileA);
  const textB = fit ? "" : new TextDecoder().decode(fileB);
  if (!fit && !(isGpx(textA) && isGpx(textB))) {
    throw new Error(
      "Both files need to be the same kind (two .fit files or two .gpx files) to be joined.",
    );
  }
  const part = (bytes: Uint8Array, text: string): Part => {
    const points = fit ? fitTimes(bytes) : parseGpx(text).points;
    const ts = times(points);
    if (ts.length === 0) throw new Error("One of the files has no times, so the order can't be worked out.");
    return { bytes, points, start: Math.min(...ts), end: Math.max(...ts) };
  };
  const a = part(fileA, textA);
  const b = part(fileB, textB);
  const firstIndex = a.start <= b.start ? 0 : 1;
  const [first, second] = firstIndex === 0 ? [a, b] : [b, a];
  if (second.start < first.end) {
    throw new Error(
      "The two recordings overlap in time, so they can't be put one after the other. " +
        "If they're the same activity recorded on two devices, use “Same activity on two devices” instead.",
    );
  }
  const gapMinutes = (second.start - first.end) / 60000;

  if (fit) {
    const data = joinFit(first, second);
    const problems = verifyJoinedFit(first.bytes, second.bytes, data);
    return { kind: "fit", data, points: positionsOf(data), firstIndex, gapMinutes, problems };
  }
  const [firstText, secondText] = firstIndex === 0 ? [textA, textB] : [textB, textA];
  const joined = joinGpx(firstText, secondText);
  return {
    kind: "gpx",
    data: new TextEncoder().encode(joined),
    points: parseGpx(joined).points,
    firstIndex,
    gapMinutes,
    problems: verifyJoinedGpx(firstText, secondText, joined),
  };
}

/** Every record's time (and position, if any), so we can order the files. */
function fitTimes(bytes: Uint8Array): TrackPoint[] {
  const parsed = parseFit(bytes);
  const fitEpoch = Date.UTC(1989, 11, 31);
  return parsed.records.map((r) => ({
    lat: r.point >= 0 ? parsed.points[r.point].lat : null,
    lon: r.point >= 0 ? parsed.points[r.point].lon : null,
    time: r.time === null ? null : fitEpoch + r.time * 1000,
  }));
}

function positionsOf(fitBytes: Uint8Array): TrackPoint[] {
  return parseFit(fitBytes).points;
}

/** The highest running distance (metres) a FIT file records, or 0. */
function finalDistance(bytes: Uint8Array): number {
  let max = 0;
  forEachRecordDistance(bytes, (cm) => {
    if (cm / 100 > max) max = cm / 100;
  });
  return max;
}

/** Calls back with each record's distance (cm) and where it is stored. */
function forEachRecordDistance(
  bytes: Uint8Array,
  cb: (cm: number, offset: number, littleEndian: boolean) => void,
) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  walkFit(bytes, {
    data(def, start) {
      if (def.globalNum !== RECORD_MESG) return;
      let pos = start + 1;
      for (const f of def.fields) {
        if (f.num === RECORD_FIELDS.distance && f.size === 4) {
          const cm = view.getUint32(pos, def.littleEndian);
          if (cm !== INVALID_UINT32) cb(cm, pos, def.littleEndian);
        }
        pos += f.size;
      }
    },
  });
}

function joinFit(first: Part, second: Part): Uint8Array {
  // Distance carries on from where the first part stopped.
  const from = lastPosition(first.points, true);
  const to = lastPosition(second.points, false);
  const gap = from && to ? metresBetween(from.lat, from.lon, to.lat, to.lon) : 0;
  const offsetCm = Math.round((finalDistance(first.bytes) + gap) * 100);

  const secondCopy = new Uint8Array(second.bytes);
  const view = new DataView(secondCopy.buffer);
  forEachRecordDistance(secondCopy, (cm, offset, littleEndian) => {
    view.setUint32(offset, Math.min(INVALID_UINT32 - 1, cm + offsetCm), littleEndian);
  });

  const chunks: Uint8Array[] = [];
  let header: Uint8Array | null = null;
  walkFit(first.bytes, {
    segment(seg) {
      header ??= first.bytes.slice(seg.start, seg.start + seg.headerSize);
      chunks.push(first.bytes.subarray(seg.start + seg.headerSize, seg.dataEnd));
    },
  });
  // The second file's own "file id" is left out: a file has one.
  walkFit(secondCopy, {
    definition(_def, _local, start, end) {
      chunks.push(secondCopy.subarray(start, end));
    },
    data(def, start, end) {
      if (def.globalNum !== FILE_ID_MESG) chunks.push(secondCopy.subarray(start, end));
    },
  });

  return buildSegment(header!, chunks);
}

/**
 * Safety check: the joined file must hold every message of the first file,
 * then every message of the second (except its file id), unchanged, apart
 * from the second part's running distance.
 */
export function verifyJoinedFit(first: Uint8Array, second: Uint8Array, joined: Uint8Array): string[] {
  let got: RawMessage[];
  try {
    got = readMessages(joined);
  } catch {
    return ["The joined file can't be read back."];
  }
  const problems = checksumProblems(joined, "joined");
  const a = readMessages(first);
  const b = readMessages(second).filter((m) => m.globalNum !== FILE_ID_MESG);
  const want = [...a, ...b];
  if (got.length !== want.length) return [...problems, "The joined file has a different number of messages."];
  for (let i = 0; i < want.length && problems.length < 6; i++) {
    const x = want[i];
    const y = got[i];
    const mayChangeDistance = i >= a.length && x.globalNum === RECORD_MESG;
    const same =
      x.globalNum === y.globalNum &&
      x.header === y.header &&
      x.dev === y.dev &&
      x.fields.size === y.fields.size &&
      [...x.fields].every(
        ([num, v]) => y.fields.get(num) === v || (mayChangeDistance && num === RECORD_FIELDS.distance),
      );
    if (!same) problems.push(`Message ${i + 1} of the joined file doesn't match the original.`);
  }
  return problems;
}

/* ---------- GPX ---------- */

const TRKSEG = /<((?:[\w-]+:)?)trkseg\b[^>]*>[\s\S]*?<\/\1trkseg>/g;
const TRKPT = /<((?:[\w-]+:)?)trkpt\b[\s\S]*?<\/\1trkpt>|<(?:[\w-]+:)?trkpt\b[^>]*\/>/g;

/** Adds the second file's track segments to the first file's track. */
function joinGpx(first: string, second: string): string {
  const segments = second.match(TRKSEG);
  if (!segments) throw new Error("The second GPX file has no track segments.");
  const close = /<\/((?:[\w-]+:)?)trk>(?![\s\S]*<\/(?:[\w-]+:)?trk>)/.exec(first);
  if (!close) throw new Error("The first GPX file has no track.");
  let out = first.slice(0, close.index) + segments.join("\n") + "\n" + first.slice(close.index);
  // Bring along namespace declarations (e.g. for heart rate extensions) the
  // first file doesn't have.
  const rootOf = (text: string) => /<gpx\b[^>]*>/.exec(text)![0];
  const decls = (tag: string) => new Map([...tag.matchAll(/\sxmlns:([\w-]+)\s*=\s*("[^"]*"|'[^']*')/g)].map((m) => [m[1], m[0]]));
  const have = decls(rootOf(out));
  const missing = [...decls(rootOf(second))].filter(([prefix]) => !have.has(prefix)).map(([, d]) => d);
  if (missing.length) {
    const root = rootOf(out);
    const at = out.indexOf(root) + root.length - (root.endsWith("/>") ? 2 : 1);
    out = out.slice(0, at) + missing.join("") + out.slice(at);
  }
  return out;
}

/** Safety check: the joined file's track points are exactly both files' points, in order. */
export function verifyJoinedGpx(first: string, second: string, joined: string): string[] {
  const pts = (text: string) => text.match(TRKPT) ?? [];
  const want = [...pts(first), ...pts(second)];
  const got = pts(joined);
  if (want.length !== got.length) return ["The joined file has a different number of points."];
  if (want.some((p, i) => p !== got[i])) return ["A point in the joined file doesn't match the original."];
  try {
    parseGpx(joined);
  } catch {
    return ["The joined file can't be read back."];
  }
  return [];
}

/** Turns "Morning_Ride.fit" into "Morning_Ride-joined.fit". */
export function joinedFileName(name: string, kind: "fit" | "gpx"): string {
  const base = name.replace(/\.gz$/i, "").replace(/\.(fit|gpx)$/i, "");
  return `${base}-joined.${kind}`;
}
