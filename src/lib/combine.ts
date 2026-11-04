/**
 * Combining several recordings into one activity, taking each kind of data
 * (GPS track, heart rate, cadence, ...) from the file you choose.
 *
 * The values themselves are never changed: at every moment, each kind of
 * data is copied from the chosen file's own sample at that moment (positions
 * are interpolated between GPS points, as when merging). Only distance and
 * speed are worked out again, from the final GPS track.
 *
 * There are three ways to write the result, and we use the most faithful one
 * that fits your choices:
 *
 *  - "exact": everything except the GPS track comes from one file. That
 *    file is copied as it is (laps, device details and all) and only its
 *    positions change. Uses `mergePositions` and its safety check.
 *  - "join": two files recorded one after the other, everything kept. Uses
 *    `joinActivities` and its safety check.
 *  - "rebuild": anything else. A new file is written from the chosen data.
 *    Laps and device details can't be carried over. `verifyCombined` reads
 *    the new file back and checks that every value in it was recorded by
 *    one of the files at that moment, and that nothing you turned off is in it.
 */

import { Encoder, Profile } from "@garmin/fitsdk";
import { joinActivities } from "./join";
import { mergePositions } from "./merge";
import {
  CHANNELS,
  covers,
  positionAt,
  readSource,
  samplesNear,
  SENSOR_CHANNELS,
  valueAt,
  type Channel,
  type Sample,
  type SensorChannel,
  type Source,
} from "./sources";
import { metresBetween, type TrackPoint } from "./track";

export interface Choices {
  /** For each kind of data, the index of the file to take it from, or null for none. */
  pick: Partial<Record<Channel, number | null>>;
  /** Where the chosen file has no data, use the other files (in list order). */
  fill: boolean;
  /** Sport for a rebuilt file, or null to use the files' own. */
  sport: string | null;
}

/** A sensible starting point: GPS from the file with the densest track, everything else from the first file that has it. */
export function defaultChoices(sources: Source[]): Choices {
  const pick: Choices["pick"] = {};
  let best = -1;
  let bestDensity = 0;
  sources.forEach((s, i) => {
    const n = s.samples.filter((x) => x.lat !== undefined).length;
    const density = n / ((s.end - s.start) / 60000 + 1);
    if (density > bestDensity) {
      best = i;
      bestDensity = density;
    }
  });
  if (best >= 0) pick.gps = best;
  for (const c of SENSOR_CHANNELS) {
    const i = sources.findIndex((s) => s.channels.includes(c));
    if (i >= 0) pick[c] = i;
  }
  return { pick, fill: true, sport: null };
}

/** The files to try for a kind of data, best first. */
function order(sources: Source[], choices: Choices, c: Channel): number[] {
  const chosen = choices.pick[c];
  if (chosen === null || chosen === undefined || !sources[chosen]) return [];
  const rest = choices.fill ? sources.map((_, i) => i).filter((i) => i !== chosen && sources[i].channels.includes(c)) : [];
  return [chosen, ...rest];
}

/** One moment of the combined activity, and which file each value came from. */
export interface Row extends Sample {
  from: Partial<Record<Channel, number>>;
}

/** Works out the combined samples: one per moment that any chosen file recorded. */
export function combineRows(sources: Source[], choices: Choices): Row[] {
  const orders = new Map(CHANNELS.map((c) => [c.key, order(sources, choices, c.key)]));
  const times = new Set<number>();
  sources.forEach((src, i) => {
    const wanted = CHANNELS.map((c) => c.key).filter((c) => orders.get(c)!.includes(i));
    if (wanted.length === 0) return;
    for (const s of src.samples) {
      if (wanted.some((c) => (c === "gps" ? s.lat !== undefined : s[c] !== undefined))) {
        times.add(Math.round(s.time / 1000) * 1000);
      }
    }
  });
  const rows: Row[] = [];
  for (const t of [...times].sort((a, b) => a - b)) {
    const row: Row = { time: t, from: {} };
    for (const i of orders.get("gps")!) {
      const pos = positionAt(sources[i], t);
      if (pos) {
        row.lat = pos.lat;
        row.lon = pos.lon;
        row.from.gps = i;
        break;
      }
    }
    for (const c of SENSOR_CHANNELS) {
      for (const i of orders.get(c)!) {
        const v = valueAt(sources[i], c, t);
        if (v !== null) {
          row[c] = v;
          row.from[c] = i;
          break;
        }
      }
    }
    if (Object.keys(row.from).length) rows.push(row);
  }
  return rows;
}

export interface Plan {
  how: "exact" | "join" | "rebuild";
  /** For "exact": the file that is copied. */
  base?: number;
  /** For "join": the two files. */
  pair?: [number, number];
  /** Why the more faithful ways didn't fit (for "rebuild"). */
  reason?: string;
  rows: Row[];
  /** Files that give at least one value. */
  used: number[];
}

export function planCombine(sources: Source[], choices: Choices): Plan {
  const rows = combineRows(sources, choices);
  const used = [...new Set(rows.flatMap((r) => Object.values(r.from)))].sort((a, b) => a - b);
  const sensorFrom = new Set(rows.flatMap((r) => SENSOR_CHANNELS.map((c) => r.from[c]).filter((i) => i !== undefined)));
  if (rows.length === 0) return { how: "rebuild", rows, used, reason: "Nothing is chosen." };

  // Exact: one file gives everything except the GPS track.
  const base = sensorFrom.size === 1 ? [...sensorFrom][0] : sensorFrom.size === 0 ? choices.pick.gps ?? undefined : undefined;
  let reason = "the heart rate and other data come from more than one file";
  if (base !== undefined && base !== null) {
    const b = sources[base];
    const excluded = SENSOR_CHANNELS.filter((c) => b.channels.includes(c) && choices.pick[c] !== base);
    if (excluded.length) {
      reason = `${b.name} has ${excluded.map(label).join(", ")} that you didn't choose from it`;
    } else if (!rows.every((r) => covers(b, r.time))) {
      reason = `some of the chosen data is from moments ${b.name} didn't record`;
    } else if (b.kind === "gpx" && b.channels.includes("gps") && !order(sources, choices, "gps").includes(base)) {
      reason = `${b.name} is a GPX file, so its own positions can't be removed`;
    } else {
      return { how: "exact", base, rows, used };
    }
  }

  // Join: two files of the same kind, one after the other, everything kept.
  if (used.length === 2 && choices.fill) {
    const [a, b] = used.map((i) => sources[i]);
    const separate = a.end < b.start || b.end < a.start;
    const all = CHANNELS.every((c) => !(a.channels.includes(c.key) || b.channels.includes(c.key)) || choices.pick[c.key] != null);
    if (a.kind === b.kind && separate && all) return { how: "join", pair: [used[0], used[1]], rows, used };
  }
  return { how: "rebuild", rows, used, reason };
}

const label = (c: Channel) => CHANNELS.find((x) => x.key === c)!.label.toLowerCase();

export interface CombineResult {
  kind: "fit" | "gpx";
  data: Uint8Array;
  fileName: string;
  /** The final track, for the map. */
  points: TrackPoint[];
  summary: string;
  problems: string[];
}

const baseName = (name: string) => name.replace(/\.gz$/i, "").replace(/\.(fit|gpx)$/i, "");

export function buildCombined(sources: Source[], choices: Choices, plan: Plan): CombineResult {
  const first = sources[plan.used[0] ?? 0];
  if (plan.how === "exact") {
    const b = sources[plan.base!];
    const gpsOrder = order(sources, choices, "gps");
    const result = mergePositions(b.bytes, (points) =>
      points.map((p) => {
        if (p.time === null) return undefined;
        for (const i of gpsOrder) {
          if (i === plan.base) {
            // The file's own position, if it has one here: keep it untouched.
            if (p.lat !== null && p.lon !== null) return undefined;
            continue;
          }
          const pos = positionAt(sources[i], p.time);
          if (pos) return pos;
        }
        return null;
      }),
    );
    return {
      kind: result.kind,
      data: result.data,
      fileName: `${baseName(b.name)}-combined.${result.kind}`,
      points: result.points,
      problems: result.problems,
      summary:
        `${b.name} is kept exactly as recorded (laps, device details and all)` +
        (result.changed ? `, with ${result.changed} positions from the chosen GPS track.` : "."),
    };
  }
  if (plan.how === "join") {
    const [i, j] = plan.pair!;
    const r = joinActivities(sources[i].bytes, sources[j].bytes);
    const firstName = sources[r.firstIndex === 0 ? i : j].name;
    return {
      kind: r.kind,
      data: r.data,
      fileName: `${baseName(firstName)}-combined.${r.kind}`,
      points: r.points,
      problems: r.problems,
      summary: `The two recordings are put one after the other, with everything in them kept as recorded.`,
    };
  }

  // Rebuild. A FIT file can only hold whole numbers for heart rate etc., so
  // if any of those come from a GPX file we write GPX to keep them exact.
  const sensorKinds = new Set(plan.rows.flatMap((r) => SENSOR_CHANNELS.map((c) => r.from[c]).filter((i) => i !== undefined).map((i) => sources[i!].kind)));
  const kind: "fit" | "gpx" =
    sensorKinds.size ? (sensorKinds.has("gpx") ? "gpx" : "fit") : plan.used.some((i) => sources[i].kind === "fit") ? "fit" : "gpx";
  const sport = choices.sport ?? sources[plan.used.find((i) => sources[i].sport) ?? -1]?.sport ?? null;
  const title = plan.used.map((i) => sources[i].title).find(Boolean) ?? null;
  const rows = kind === "gpx" ? plan.rows.filter((r) => r.lat !== undefined) : plan.rows;
  const dropped = plan.rows.length - rows.length;
  const data = kind === "fit" ? writeFitRows(rows, sport) : new TextEncoder().encode(writeGpxRows(rows, sport, title));
  const problems = verifyCombined(sources, choices, data, rows.length);
  return {
    kind,
    data,
    fileName: `${baseName(first.name)}-combined.${kind}`,
    points: rows.map((r) => ({ lat: r.lat ?? null, lon: r.lon ?? null, time: r.time })),
    problems,
    summary:
      `A new ${kind.toUpperCase()} file is built from the chosen data (${rows.length} samples), because ${plan.reason}. ` +
      `Every value is copied as recorded, but laps and device details from the original files aren't carried over.` +
      (dropped ? ` ${dropped} samples have no position and can't be stored in a GPX file, so they're left out.` : ""),
  };
}

/* ---------- Writing a new file ---------- */

const FIT_SPORTS: Record<string, string> = { cycling: "cycling", running: "running", walking: "walking", hiking: "hiking" };

/** Distance travelled (m) up to each row, and speed (m/s) at each row, from the GPS track. */
function distances(rows: Row[]): { distance: (number | undefined)[]; speed: (number | undefined)[] } {
  const distance: (number | undefined)[] = [];
  const speed: (number | undefined)[] = [];
  let total = 0;
  let prev: Row | null = null;
  for (const r of rows) {
    if (r.lat === undefined || r.lon === undefined) {
      distance.push(prev ? total : undefined);
      speed.push(undefined);
      continue;
    }
    if (prev) {
      const step = metresBetween(prev.lat!, prev.lon!, r.lat, r.lon);
      total += step;
      const dt = (r.time - prev.time) / 1000;
      speed.push(dt > 0 ? step / dt : 0);
    } else {
      speed.push(0);
    }
    distance.push(total);
    prev = r;
  }
  return { distance, speed };
}

function writeFitRows(rows: Row[], sport: string | null): Uint8Array {
  const encoder = new Encoder();
  // The SDK's message types are stricter than these plain objects.
  const write = (num: number, mesg: object) => encoder.onMesg(num, mesg as Parameters<Encoder["onMesg"]>[1]);
  const start = new Date(rows[0].time);
  const end = new Date(rows[rows.length - 1].time);
  const elapsed = (end.getTime() - start.getTime()) / 1000;
  const { distance, speed } = distances(rows);
  const total = distance.filter((d) => d !== undefined).pop() ?? 0;
  const toSemi = (deg: number) => Math.round((deg * 2 ** 31) / 180);

  write(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer: "development", product: 0, timeCreated: start });
  write(Profile.MesgNum.EVENT, { timestamp: start, event: "timer", eventType: "start" });
  rows.forEach((r, i) => {
    const rec: Record<string, unknown> = { timestamp: new Date(r.time) };
    if (r.lat !== undefined && r.lon !== undefined) {
      rec.positionLat = toSemi(r.lat);
      rec.positionLong = toSemi(r.lon);
    }
    if (r.elevation !== undefined) rec.altitude = r.elevation;
    if (r.heartRate !== undefined) rec.heartRate = r.heartRate;
    if (r.cadence !== undefined) rec.cadence = r.cadence;
    if (r.power !== undefined) rec.power = r.power;
    if (r.temperature !== undefined) rec.temperature = r.temperature;
    if (distance[i] !== undefined) rec.distance = distance[i];
    if (speed[i] !== undefined) rec.speed = speed[i];
    write(Profile.MesgNum.RECORD, rec);
  });
  write(Profile.MesgNum.EVENT, { timestamp: end, event: "timer", eventType: "stopAll" });
  const summary = {
    timestamp: end,
    startTime: start,
    totalElapsedTime: elapsed,
    totalTimerTime: elapsed,
    totalDistance: total,
    avgSpeed: elapsed > 0 ? total / elapsed : 0,
  };
  write(Profile.MesgNum.LAP, { ...summary, event: "lap", eventType: "stop" });
  write(Profile.MesgNum.SESSION, { ...summary, event: "session", eventType: "stop", sport: FIT_SPORTS[sport ?? ""] ?? "generic", numLaps: 1 });
  write(Profile.MesgNum.ACTIVITY, { timestamp: end, totalTimerTime: elapsed, numSessions: 1, type: "manual", event: "activity", eventType: "stop" });
  return encoder.close();
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function writeGpxRows(rows: Row[], sport: string | null, title: string | null): string {
  const iso = (t: number) => new Date(t).toISOString().replace(/\.000Z$/, "Z");
  const lines = rows.map((r) => {
    const tpx = [
      r.temperature !== undefined ? `<gpxtpx:atemp>${r.temperature}</gpxtpx:atemp>` : "",
      r.heartRate !== undefined ? `<gpxtpx:hr>${r.heartRate}</gpxtpx:hr>` : "",
      r.cadence !== undefined ? `<gpxtpx:cad>${r.cadence}</gpxtpx:cad>` : "",
    ].join("");
    const ext =
      tpx || r.power !== undefined
        ? `<extensions>${r.power !== undefined ? `<power>${r.power}</power>` : ""}${tpx ? `<gpxtpx:TrackPointExtension>${tpx}</gpxtpx:TrackPointExtension>` : ""}</extensions>`
        : "";
    const ele = r.elevation !== undefined ? `<ele>${r.elevation}</ele>` : "";
    return `   <trkpt lat="${r.lat}" lon="${r.lon}">${ele}<time>${iso(r.time)}</time>${ext}</trkpt>`;
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="Strava Fixer" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">`,
    ` <metadata><time>${iso(rows[0].time)}</time></metadata>`,
    ` <trk>`,
    title ? `  <name>${xml(title)}</name>` : "",
    sport ? `  <type>${sport}</type>` : "",
    `  <trkseg>`,
    ...lines,
    `  </trkseg>`,
    ` </trk>`,
    `</gpx>`,
    ``,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/* ---------- Safety check ---------- */

/**
 * Reads a rebuilt file back and checks it against the loaded files: every
 * sample's time must be a moment one of them recorded, every heart rate,
 * cadence, power, temperature and elevation value must be exactly what one
 * of them recorded at that moment, and kinds of data you turned off must be
 * absent. Returns problems (empty means OK).
 */
export function verifyCombined(sources: Source[], choices: Choices, data: Uint8Array, expected: number): string[] {
  let out: Source;
  try {
    out = readSource("combined", data);
  } catch {
    return ["The new file can't be read back."];
  }
  const problems: string[] = [];
  if (out.samples.length !== expected) problems.push("The new file has a different number of samples than expected.");
  const recorded = new Set(sources.flatMap((s) => s.samples.map((x) => Math.round(x.time / 1000) * 1000)));
  for (const s of out.samples) {
    if (problems.length > 5) break;
    if (!recorded.has(s.time)) {
      problems.push(`The new file has a sample at ${new Date(s.time).toISOString()}, which none of the files recorded.`);
      continue;
    }
    for (const c of SENSOR_CHANNELS) {
      const v = s[c];
      if (v === undefined) continue;
      if (choices.pick[c] == null) {
        const msg = `The new file has ${label(c)}, which you turned off.`;
        if (!problems.includes(msg)) problems.push(msg);
        continue;
      }
      const ok = sources.some((src) => samplesNear(src, s.time).some((x) => x[c] === v));
      if (!ok) {
        problems.push(`A ${label(c)} value at ${new Date(s.time).toISOString()} isn't one any file recorded then.`);
        break;
      }
    }
  }
  return problems;
}

export type { SensorChannel };
