/**
 * Reads the activity files the Activity library understands into one shape:
 *
 *  - FIT (watches, TomTom, Garmin, Strava's own export, ...)
 *  - GPX (most apps)
 *  - TCX (TomTom, Garmin, Google Fit's Takeout "Activities" folder)
 *  - Nike Run Club JSON (one activity, or a list of them, per file)
 *  - Google Fit Takeout "All Sessions" JSON (a summary: sport, times,
 *    distance, but no track)
 *
 * Values are kept as recorded. Nothing is worked out here except, for files
 * that don't store a total distance, the length of the GPS track.
 */

import { Decoder, Stream } from "@garmin/fitsdk";
import { isFit } from "../fitbytes";
import { isGpx } from "../gpx";
import { readGpxSamples, type Channel, type Sample } from "../sources";
import { metresBetween } from "../track";
import { guessSport } from "./sports";

export type Format = "fit" | "gpx" | "tcx" | "nike" | "googlefit";

export const FORMAT_LABELS: Record<Format, string> = {
  fit: "FIT",
  gpx: "GPX",
  tcx: "TCX",
  nike: "Nike Run Club JSON",
  googlefit: "Google Fit session",
};

export interface ActivitySample extends Sample {
  /** Distance travelled so far, in metres, as the file recorded it. */
  distance?: number;
}

export interface Activity {
  format: Format;
  /** Our sport key (see sports.ts), or null if the file doesn't say. */
  sport: string | null;
  /** The sport as written in the file, for showing. */
  rawSport: string | null;
  title: string | null;
  /** The app or device that made the file, if it says. */
  device: string | null;
  /** Milliseconds since 1970. */
  start: number;
  end: number;
  /** Total distance in metres (from the file, or else the GPS track), or null. */
  distance: number | null;
  /** Sorted by time. Empty for summary-only activities. */
  samples: ActivitySample[];
  /** Which kinds of data the samples hold. */
  channels: Channel[];
}

/* ---------- helpers ---------- */

const CHANNEL_KEYS: Channel[] = ["gps", "elevation", "heartRate", "cadence", "power", "temperature"];
const hasChannel = (s: Sample, c: Channel) => (c === "gps" ? s.lat !== undefined && s.lon !== undefined : s[c] !== undefined);

function trackLength(samples: Sample[]): number {
  let total = 0;
  let prev: Sample | null = null;
  for (const s of samples) {
    if (s.lat === undefined || s.lon === undefined) continue;
    if (prev) total += metresBetween(prev.lat!, prev.lon!, s.lat, s.lon);
    prev = s;
  }
  return total;
}

/** Sorts samples, merges ones with the same time, and fills in the summary fields. */
function finish(a: Omit<Activity, "channels" | "start" | "end"> & { start?: number; end?: number }): Activity {
  const byTime = new Map<number, ActivitySample>();
  for (const s of a.samples) {
    if (!Number.isFinite(s.time)) continue;
    const prev = byTime.get(s.time);
    if (!prev) byTime.set(s.time, { ...s });
    else {
      const p = prev as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(s)) if (p[k] === undefined) p[k] = v;
    }
  }
  const samples = [...byTime.values()].sort((x, y) => x.time - y.time);
  const start = a.start ?? samples[0]?.time;
  const end = a.end ?? samples[samples.length - 1]?.time;
  if (start === undefined || !Number.isFinite(start)) throw new Error("No date or time found in this file.");
  const channels = CHANNEL_KEYS.filter((c) => samples.some((s) => hasChannel(s, c)));
  let distance = a.distance;
  if (distance == null || !Number.isFinite(distance) || distance <= 0) {
    const last = [...samples].reverse().find((s) => s.distance !== undefined)?.distance;
    distance = last ?? (channels.includes("gps") ? trackLength(samples) : null);
  }
  return { ...a, samples, channels, start, end: Math.max(end ?? start, start), distance };
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** A hint at the sport from a file name, e.g. Google Takeout's "2019-03-30T09_15_32+01_00_RUNNING.tcx". */
export function sportFromName(name: string): string | null {
  const base = name.split("/").pop() ?? name;
  return guessSport(base.replace(/\.[a-z0-9.]+$/i, "").replace(/[0-9]/g, " "));
}

/* ---------- FIT ---------- */

const SEMI = 180 / 2 ** 31;

function readFit(bytes: Uint8Array): Activity {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  const { messages } = decoder.read({ convertTypesToStrings: true });
  const m = messages as unknown as Record<string, Record<string, unknown>[] | undefined>;
  const samples: ActivitySample[] = (m.recordMesgs ?? []).map((r) => {
    const lat = num(r.positionLat);
    const lon = num(r.positionLong);
    const s: ActivitySample = { time: r.timestamp instanceof Date ? r.timestamp.getTime() : NaN };
    if (lat !== undefined && lon !== undefined) {
      s.lat = lat * SEMI;
      s.lon = lon * SEMI;
    }
    const fields: [keyof ActivitySample, unknown][] = [
      ["elevation", num(r.enhancedAltitude) ?? num(r.altitude)],
      ["heartRate", num(r.heartRate)],
      ["cadence", num(r.cadence)],
      ["power", num(r.power)],
      ["temperature", num(r.temperature)],
      ["distance", num(r.distance)],
    ];
    for (const [k, v] of fields) if (v !== undefined) (s as unknown as Record<string, unknown>)[k] = v;
    return s;
  });
  const session = m.sessionMesgs?.[0];
  const sportMesg = m.sportMesgs?.[0];
  const fileId = m.fileIdMesgs?.[0];
  const sport = (session?.sport ?? sportMesg?.sport) as string | undefined;
  const subSport = (session?.subSport ?? sportMesg?.subSport) as string | undefined;
  const startTime = session?.startTime instanceof Date ? session.startTime.getTime() : undefined;
  const elapsed = num(session?.totalElapsedTime);
  const maker = typeof fileId?.manufacturer === "string" ? fileId.manufacturer : null;
  const product = fileId?.garminProduct ?? fileId?.productName ?? null;
  const name = typeof sportMesg?.name === "string" && sportMesg.name.trim() ? sportMesg.name.trim() : null;
  const sportKey = sport === "generic" && (!subSport || subSport === "generic") ? null : guessSport(sport, subSport === "generic" ? null : subSport);
  return finish({
    format: "fit",
    sport: sportKey,
    rawSport: sport ? [sport, subSport && subSport !== "generic" ? subSport : ""].filter(Boolean).join(" / ") : null,
    title: name,
    device: maker ? [maker, typeof product === "string" ? product : ""].filter(Boolean).join(" ") : null,
    start: samples.length ? undefined : startTime,
    end: samples.length ? undefined : startTime !== undefined && elapsed !== undefined ? startTime + elapsed * 1000 : startTime,
    distance: num(session?.totalDistance) ?? null,
    samples,
  });
}

/* ---------- GPX ---------- */

function readGpx(text: string): Activity {
  const creator = /<(?:[\w-]+:)?gpx\b[^>]*\screator\s*=\s*["']([^"']*)["']/.exec(text)?.[1] ?? null;
  const trk = /<(?:[\w-]+:)?trk\b[^>]*>([\s\S]*?)<(?:[\w-]+:)?trkseg\b/.exec(text)?.[1] ?? "";
  const title = /<(?:[\w-]+:)?name>(?:<!\[CDATA\[)?([^<\]]*)/.exec(trk)?.[1]?.trim() || null;
  const type = /<(?:[\w-]+:)?type>(?:<!\[CDATA\[)?([^<\]]*)/.exec(trk)?.[1]?.trim() || null;
  const samples = readGpxSamples(text);
  if (!samples.length) throw new Error("This GPX file has no timed track points (it may be a planned route).");
  return finish({
    format: "gpx",
    sport: guessSport(type),
    rawSport: type,
    title: title ? decodeXml(title) : null,
    device: creator ? decodeXml(creator) : null,
    distance: null,
    samples,
  });
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/* ---------- TCX ---------- */

export function isTcx(text: string): boolean {
  return /<(?:[\w-]+:)?TrainingCenterDatabase\b/.test(text.slice(0, 4000));
}

const tcxTag = (body: string, name: string) => {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>\\s*([^<\\s]+)\\s*<`).exec(body);
  return m ? m[1] : undefined;
};

function readTcx(text: string): Activity[] {
  const out: Activity[] = [];
  const creatorBlock = /<(?:[\w-]+:)?Creator\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Creator>/.exec(text)?.[1] ?? "";
  const device = /<(?:[\w-]+:)?Name>([^<]*)</.exec(creatorBlock)?.[1]?.trim() || null;
  for (const act of text.matchAll(/<(?:[\w-]+:)?Activity\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?Activity>/g)) {
    const sportAttr = /Sport\s*=\s*["']([^"']*)["']/.exec(act[1])?.[1] ?? null;
    const body = act[2];
    const samples: ActivitySample[] = [];
    let lapDistance = 0;
    let hasLapDistance = false;
    let lapStart: number | undefined;
    let lapSeconds = 0;
    for (const lap of body.matchAll(/<(?:[\w-]+:)?Lap\b([^>]*)>([\s\S]*?)<\/(?:[\w-]+:)?Lap>/g)) {
      const head = lap[2].split(/<(?:[\w-]+:)?Track\b/)[0];
      const d = num(tcxTag(head, "DistanceMeters"));
      if (d !== undefined) {
        lapDistance += d;
        hasLapDistance = true;
      }
      lapSeconds += num(tcxTag(head, "TotalTimeSeconds")) ?? 0;
      const st = /StartTime\s*=\s*["']([^"']*)["']/.exec(lap[1])?.[1];
      if (st && lapStart === undefined) lapStart = Date.parse(st);
    }
    for (const tp of body.matchAll(/<(?:[\w-]+:)?Trackpoint\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Trackpoint>/g)) {
      const b = tp[1];
      const time = tcxTag(b, "Time");
      if (!time) continue;
      const s: ActivitySample = { time: Date.parse(time) };
      const lat = num(tcxTag(b, "LatitudeDegrees"));
      const lon = num(tcxTag(b, "LongitudeDegrees"));
      if (lat !== undefined && lon !== undefined) {
        s.lat = lat;
        s.lon = lon;
      }
      const hrBlock = /<(?:[\w-]+:)?HeartRateBpm\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?HeartRateBpm>/.exec(b)?.[1];
      const values: [keyof ActivitySample, number | undefined][] = [
        ["elevation", num(tcxTag(b, "AltitudeMeters"))],
        ["distance", num(tcxTag(b, "DistanceMeters"))],
        ["heartRate", hrBlock ? num(tcxTag(hrBlock, "Value")) : undefined],
        ["cadence", num(tcxTag(b, "Cadence")) ?? num(tcxTag(b, "RunCadence"))],
        ["power", num(tcxTag(b, "Watts"))],
      ];
      for (const [k, v] of values) if (v !== undefined) (s as unknown as Record<string, number>)[k] = v;
      samples.push(s);
    }
    const notes = tcxTag(body, "Notes");
    const id = tcxTag(body, "Id");
    const start = samples.length ? undefined : (lapStart ?? (id ? Date.parse(id) : undefined));
    out.push(
      finish({
        format: "tcx",
        sport: guessSport(sportAttr),
        rawSport: sportAttr,
        title: notes ? decodeXml(notes) : null,
        device,
        start,
        end: start !== undefined ? start + lapSeconds * 1000 : undefined,
        distance: hasLapDistance ? lapDistance : null,
        samples,
      }),
    );
  }
  if (!out.length) throw new Error("This TCX file has no activities in it.");
  return out;
}

/* ---------- Nike Run Club JSON ---------- */

type Json = Record<string, unknown>;

interface NikeMetric {
  type?: string;
  unit?: string;
  values?: { start_epoch_ms?: number; end_epoch_ms?: number; value?: number }[];
}

const isNike = (o: unknown): o is Json =>
  !!o && typeof o === "object" && "start_epoch_ms" in (o as Json) && ("metrics" in (o as Json) || "summaries" in (o as Json));

function readNikeOne(o: Json): Activity {
  const metrics = (Array.isArray(o.metrics) ? o.metrics : []) as NikeMetric[];
  const byTime = new Map<number, ActivitySample>();
  const at = (t: number) => {
    let s = byTime.get(t);
    if (!s) byTime.set(t, (s = { time: t }));
    return s;
  };
  const metric = (type: string) => metrics.find((x) => x.type === type)?.values ?? [];
  const lats = metric("latitude");
  const lons = metric("longitude");
  const lonAt = new Map(lons.map((v) => [v.start_epoch_ms, v.value]));
  for (const v of lats) {
    const lon = lonAt.get(v.start_epoch_ms);
    if (v.start_epoch_ms === undefined || v.value === undefined || lon === undefined) continue;
    const s = at(v.start_epoch_ms);
    s.lat = v.value;
    s.lon = lon;
  }
  for (const [type, key] of [
    ["elevation", "elevation"],
    ["heart_rate", "heartRate"],
    ["cadence", "cadence"],
    ["power", "power"],
  ] as const) {
    for (const v of metric(type)) if (v.start_epoch_ms !== undefined && v.value !== undefined) at(v.start_epoch_ms)[key] = v.value;
  }
  // Nike stores distance as how far you went in each stretch (in km); add them up.
  const distUnit = metrics.find((x) => x.type === "distance")?.unit?.toUpperCase();
  const toMetres = distUnit === "M" ? 1 : distUnit === "MI" ? 1609.344 : 1000;
  let total = 0;
  for (const v of [...metric("distance")].sort((a, b) => (a.start_epoch_ms ?? 0) - (b.start_epoch_ms ?? 0))) {
    if (v.value === undefined) continue;
    total += v.value * toMetres;
    at(v.end_epoch_ms ?? v.start_epoch_ms ?? 0).distance = total;
  }
  const summaries = (Array.isArray(o.summaries) ? o.summaries : []) as { metric?: string; summary?: string; value?: number }[];
  const sumDist = summaries.find((s) => s.metric === "distance" && s.summary === "total")?.value;
  const tags = (o.tags ?? {}) as Record<string, string>;
  const rawSport = (tags["com.nike.running.activitytype"] ?? tags.activityType ?? (o.type as string) ?? null) || null;
  const start = num(o.start_epoch_ms);
  const end = num(o.end_epoch_ms);
  return finish({
    format: "nike",
    sport: guessSport(rawSport) ?? (o.type === "run" ? "run" : null),
    rawSport,
    title: tags["com.nike.name"] ?? tags.name ?? null,
    device: "Nike Run Club",
    start,
    end,
    distance: sumDist !== undefined ? sumDist * toMetres : total || null,
    samples: [...byTime.values()],
  });
}

/* ---------- Google Fit "All Sessions" JSON ---------- */

const isGoogleFitSession = (o: unknown): o is Json =>
  !!o && typeof o === "object" && "fitnessActivity" in (o as Json) && "startTime" in (o as Json);

function readGoogleFitSession(o: Json): Activity {
  const start = Date.parse(String(o.startTime));
  const end = Date.parse(String(o.endTime ?? o.startTime));
  const agg = (Array.isArray(o.aggregate) ? o.aggregate : []) as { metricName?: string; floatValue?: number; intValue?: number }[];
  const dist = agg.find((a) => a.metricName === "com.google.distance.delta");
  const raw = String(o.fitnessActivity);
  return finish({
    format: "googlefit",
    sport: guessSport(raw),
    rawSport: raw,
    title: typeof o.name === "string" ? o.name : null,
    device: "Google Fit",
    start,
    end,
    distance: num(dist?.floatValue) ?? num(dist?.intValue) ?? null,
    samples: [],
  });
}

/* ---------- Entry point ---------- */

/** Extensions we try to read; anything else in a folder is listed but not opened. */
export const ACTIVITY_EXTENSIONS = /\.(fit|gpx|tcx|json)(\.gz)?$/i;

/** Thrown for files that open fine but aren't activities (e.g. Google Fit daily totals). */
export class NotAnActivity extends Error {}

/**
 * Reads one file (already unzipped if it was .gz) into the activities it
 * holds: usually one, sometimes several (TCX, Nike lists), or none.
 */
export function readActivities(name: string, bytes: Uint8Array): Activity[] {
  if (isFit(bytes)) return [readFit(bytes)];
  const text = new TextDecoder().decode(bytes);
  if (isGpx(text)) return [readGpx(text)];
  if (isTcx(text)) return readTcx(text);
  if (/\.json$/i.test(name) || /^\s*[[{]/.test(text.slice(0, 10))) {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new NotAnActivity("Not a readable JSON file.");
    }
    const list: unknown[] = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as Json).activities)
        ? ((data as Json).activities as unknown[])
        : [data];
    const out: Activity[] = [];
    for (const item of list) {
      if (isNike(item)) out.push(readNikeOne(item));
      else if (isGoogleFitSession(item)) out.push(readGoogleFitSession(item));
    }
    if (!out.length) throw new NotAnActivity("This JSON file isn't an activity (e.g. daily totals or settings).");
    return out;
  }
  throw new NotAnActivity("Not an activity file.");
}
