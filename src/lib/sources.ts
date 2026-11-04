/**
 * Reads any activity file the Merge tab accepts (FIT or GPX) into one simple
 * shape: a list of timed samples, each holding whatever
 * that file recorded at that moment (position, elevation, heart rate, ...).
 *
 * Values are kept exactly as they appear in the file, so the combined file
 * can be checked against them.
 */

import { Decoder, Stream } from "@garmin/fitsdk";
import { isFit } from "./fitbytes";
import { isGpx } from "./gpx";

export type Channel = "gps" | "elevation" | "heartRate" | "cadence" | "power" | "temperature";

export const CHANNELS: { key: Channel; label: string }[] = [
  { key: "gps", label: "GPS track" },
  { key: "elevation", label: "Elevation" },
  { key: "heartRate", label: "Heart rate" },
  { key: "cadence", label: "Cadence" },
  { key: "power", label: "Power" },
  { key: "temperature", label: "Temperature" },
];

export interface Sample {
  /** Milliseconds since 1970. */
  time: number;
  lat?: number;
  lon?: number;
  elevation?: number;
  heartRate?: number;
  cadence?: number;
  power?: number;
  temperature?: number;
}

export type SensorChannel = Exclude<Channel, "gps">;
export const SENSOR_CHANNELS: SensorChannel[] = ["elevation", "heartRate", "cadence", "power", "temperature"];

export interface Source {
  name: string;
  kind: "fit" | "gpx";
  /** The file's bytes (unzipped), for copying it exactly. */
  bytes: Uint8Array;
  /** Sorted by time; samples with the same time are combined. */
  samples: Sample[];
  channels: Channel[];
  start: number;
  end: number;
  /** "cycling", "running", "walking", "hiking" or null if unknown. */
  sport: string | null;
  /** The activity name stored in the file (GPX only), or null. */
  title: string | null;
  /** Longest gap (ms) between two GPS points that we'll draw a line across. */
  maxGapMs: number;
  /** How far (ms) from a sample its value still counts. */
  toleranceMs: number;
}

const has = (s: Sample, c: Channel) => (c === "gps" ? s.lat !== undefined && s.lon !== undefined : s[c] !== undefined);

/** Turns the many names files use for a sport into one of ours. */
export function normaliseSport(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (/bik|cycl|ride|bicycl/.test(s)) return "cycling";
  if (/run/.test(s)) return "running";
  if (/hik/.test(s)) return "hiking";
  if (/walk|foot/.test(s)) return "walking";
  return null;
}

function finish(
  name: string,
  kind: Source["kind"],
  bytes: Uint8Array,
  raw: Sample[],
  sport: string | null,
  title: string | null,
): Source {
  // Combine samples that share a time (some apps write position and heart
  // rate as separate samples), keeping the first value seen for each field.
  const byTime = new Map<number, Sample>();
  for (const s of raw) {
    if (!Number.isFinite(s.time)) continue;
    const prev = byTime.get(s.time);
    if (!prev) byTime.set(s.time, { ...s });
    else for (const [k, v] of Object.entries(s)) if ((prev as unknown as Record<string, unknown>)[k] === undefined) (prev as unknown as Record<string, unknown>)[k] = v;
  }
  const samples = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (samples.length === 0) throw new Error(`${name} has no timed samples.`);
  const channels = CHANNELS.map((c) => c.key).filter((c) => samples.some((s) => has(s, c)));
  // Typical time between samples, to judge how far a value may be "stretched".
  const gaps = samples.slice(1).map((s, i) => s.time - samples[i].time).sort((a, b) => a - b);
  const median = gaps.length ? gaps[gaps.length >> 1] : 1000;
  return {
    name,
    kind,
    bytes,
    samples,
    channels,
    start: samples[0].time,
    end: samples[samples.length - 1].time,
    sport,
    title,
    maxGapMs: 60_000,
    toleranceMs: Math.min(15_000, Math.max(2_000, median * 1.5)),
  };
}

/* ---------- FIT ---------- */

const SEMI = 180 / 2 ** 31;

function readFitSource(name: string, bytes: Uint8Array): Source {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  const { messages } = decoder.read({ convertTypesToStrings: true });
  const m = messages as unknown as Record<string, Record<string, unknown>[] | undefined>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const samples: Sample[] = (m.recordMesgs ?? []).map((r) => {
    const lat = num(r.positionLat);
    const lon = num(r.positionLong);
    const time = r.timestamp instanceof Date ? r.timestamp.getTime() : NaN;
    return {
      time,
      ...(lat !== undefined && lon !== undefined ? { lat: lat * SEMI, lon: lon * SEMI } : {}),
      elevation: num(r.enhancedAltitude) ?? num(r.altitude),
      heartRate: num(r.heartRate),
      cadence: num(r.cadence),
      power: num(r.power),
      temperature: num(r.temperature),
    };
  });
  for (const s of samples) for (const k of Object.keys(s) as (keyof Sample)[]) if (s[k] === undefined) delete s[k];
  const session = m.sessionMesgs?.[0];
  return finish(name, "fit", bytes, samples, normaliseSport(session?.sport as string | undefined), null);
}

/* ---------- GPX ---------- */

const TRKPT = /<((?:[\w-]+:)?)trkpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1trkpt>)/g;
const tag = (body: string, names: string) => {
  const m = new RegExp(`<(?:[\\w-]+:)?(?:${names})>\\s*([^<\\s]+)\\s*<`).exec(body);
  return m ? m[1] : undefined;
};
const attr = (attrs: string, name: string) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`).exec(attrs);
  return m ? Number(m[1]) : undefined;
};

export function readGpxSamples(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const m of text.matchAll(TRKPT)) {
    const body = m[3] ?? "";
    const time = tag(body, "time");
    if (!time) continue;
    const s: Sample = { time: Date.parse(time) };
    const lat = attr(m[2], "lat");
    const lon = attr(m[2], "lon");
    if (lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon)) {
      s.lat = lat;
      s.lon = lon;
    }
    const fields: [SensorChannel, string][] = [
      ["elevation", "ele"],
      ["heartRate", "hr|heartrate"],
      ["cadence", "cad|cadence"],
      ["power", "power|PowerInWatts|watts"],
      ["temperature", "atemp|temp"],
    ];
    for (const [key, names] of fields) {
      const v = tag(body, names);
      if (v !== undefined && Number.isFinite(Number(v))) s[key] = Number(v);
    }
    samples.push(s);
  }
  return samples;
}

function readGpxSource(name: string, bytes: Uint8Array, text: string): Source {
  const trk = /<(?:[\w-]+:)?trk\b[^>]*>([\s\S]*?)<(?:[\w-]+:)?trkseg\b/.exec(text)?.[1] ?? "";
  const title = /<(?:[\w-]+:)?name>([^<]*)</.exec(trk)?.[1]?.trim() || null;
  const type = /<(?:[\w-]+:)?type>([^<]*)</.exec(trk)?.[1];
  return finish(name, "gpx", bytes, readGpxSamples(text), normaliseSport(type), title);
}

/** Reads a FIT or GPX file. */
export function readSource(name: string, bytes: Uint8Array): Source {
  if (isFit(bytes)) return readFitSource(name, bytes);
  const text = new TextDecoder().decode(bytes);
  if (isGpx(text)) return readGpxSource(name, bytes, text);
  throw new Error(`${name}: please choose .fit or .gpx files.`);
}

/* ---------- Looking up values ---------- */

const cache = new WeakMap<Source, Map<Channel, Sample[]>>();

/** The source's samples that have this channel. */
function withChannel(src: Source, c: Channel): Sample[] {
  let m = cache.get(src);
  if (!m) cache.set(src, (m = new Map()));
  let list = m.get(c);
  if (!list) m.set(c, (list = src.samples.filter((s) => has(s, c))));
  return list;
}

/** Index of the last sample at or before t, or -1. */
function before(list: Sample[], t: number): number {
  let lo = -1;
  let hi = list.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (list[mid].time <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Position at time t, interpolated between the two nearest GPS points. */
export function positionAt(src: Source, t: number): { lat: number; lon: number } | null {
  const list = withChannel(src, "gps");
  const i = before(list, t);
  if (i < 0) return null;
  const p = list[i];
  if (p.time === t) return { lat: p.lat!, lon: p.lon! };
  const q = list[i + 1];
  if (!q || q.time - p.time > src.maxGapMs) return null;
  const f = (t - p.time) / (q.time - p.time);
  return { lat: p.lat! + (q.lat! - p.lat!) * f, lon: p.lon! + (q.lon! - p.lon!) * f };
}

/** The recorded value nearest to time t (not interpolated), if close enough. */
export function valueAt(src: Source, c: SensorChannel, t: number): number | null {
  const list = withChannel(src, c);
  const i = before(list, t);
  const candidates = [list[i], list[i + 1]].filter(Boolean);
  let best: Sample | null = null;
  for (const s of candidates) if (!best || Math.abs(s.time - t) < Math.abs(best.time - t)) best = s;
  return best && Math.abs(best.time - t) <= src.toleranceMs ? best[c]! : null;
}

/** Whether any of the source's samples is within its tolerance of time t. */
export function covers(src: Source, t: number): boolean {
  const i = before(src.samples, t);
  return [src.samples[i], src.samples[i + 1]].some((s) => s && Math.abs(s.time - t) <= src.toleranceMs);
}

/** The source's samples within its tolerance of time t. */
export function samplesNear(src: Source, t: number): Sample[] {
  const out: Sample[] = [];
  let i = before(src.samples, t);
  for (let j = i; j >= 0 && t - src.samples[j].time <= src.toleranceMs; j--) out.push(src.samples[j]);
  for (i = i + 1; i < src.samples.length && src.samples[i].time - t <= src.toleranceMs; i++) out.push(src.samples[i]);
  return out;
}
