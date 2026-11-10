/**
 * Writes an activity as a FIT file that Strava reads with the right sport
 * type. Every recorded value (time, position, elevation, heart rate,
 * cadence, power, temperature, distance) is copied as it is. Only when a
 * file doesn't record distance is it worked out from the GPS track, as
 * Strava itself would.
 *
 * A summary-only activity (e.g. a Google Fit session without a track)
 * becomes a file with two samples, at its start and end, holding its total
 * distance, so Strava shows it with the right time, duration and distance.
 */

import { Encoder, Profile } from "@garmin/fitsdk";
import { metresBetween } from "../track";
import type { Activity } from "./formats";
import { sportByKey, sportLabel } from "./sports";

const toSemi = (deg: number) => Math.round((deg * 2 ** 31) / 180);

export function buildStravaFit(act: Activity, sportKey: string | null): Uint8Array {
  const encoder = new Encoder();
  const write = (num: number, mesg: object) => encoder.onMesg(num, mesg as Parameters<Encoder["onMesg"]>[1]);
  const sport = sportByKey(sportKey)?.fit ?? { sport: "generic" };
  const start = new Date(act.start);
  const end = new Date(act.end);
  const elapsed = Math.max(0, (act.end - act.start) / 1000);

  // Distance so far at each sample: as recorded, or else from the GPS track.
  const recorded = act.samples.some((s) => s.distance !== undefined);
  let total = 0;
  let prev: { lat: number; lon: number } | null = null;
  const distances = act.samples.map((s) => {
    if (recorded) return s.distance;
    if (s.lat === undefined || s.lon === undefined) return prev ? total : undefined;
    if (prev) total += metresBetween(prev.lat, prev.lon, s.lat, s.lon);
    prev = { lat: s.lat, lon: s.lon };
    return total;
  });
  const totalDistance = act.distance ?? distances.filter((d) => d !== undefined).pop() ?? 0;

  write(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer: "development", product: 0, timeCreated: start });
  write(Profile.MesgNum.SPORT, { sport: sport.sport, subSport: sport.subSport ?? "generic", name: sportLabel(sportKey) });
  write(Profile.MesgNum.EVENT, { timestamp: start, event: "timer", eventType: "start" });
  if (act.samples.length) {
    act.samples.forEach((s, i) => {
      const rec: Record<string, unknown> = { timestamp: new Date(s.time) };
      if (s.lat !== undefined && s.lon !== undefined) {
        rec.positionLat = toSemi(s.lat);
        rec.positionLong = toSemi(s.lon);
      }
      if (s.elevation !== undefined) rec.altitude = s.elevation;
      if (s.heartRate !== undefined) rec.heartRate = Math.round(s.heartRate);
      if (s.cadence !== undefined) rec.cadence = Math.round(s.cadence);
      if (s.power !== undefined) rec.power = Math.round(s.power);
      if (s.temperature !== undefined) rec.temperature = Math.round(s.temperature);
      if (distances[i] !== undefined) rec.distance = distances[i];
      write(Profile.MesgNum.RECORD, rec);
    });
  } else {
    write(Profile.MesgNum.RECORD, { timestamp: start, distance: 0 });
    write(Profile.MesgNum.RECORD, { timestamp: end, distance: totalDistance });
  }
  write(Profile.MesgNum.EVENT, { timestamp: end, event: "timer", eventType: "stopAll" });
  const summary = {
    timestamp: end,
    startTime: start,
    totalElapsedTime: elapsed,
    totalTimerTime: elapsed,
    totalDistance,
    avgSpeed: elapsed > 0 ? totalDistance / elapsed : 0,
  };
  write(Profile.MesgNum.LAP, { ...summary, event: "lap", eventType: "stop", sport: sport.sport, subSport: sport.subSport ?? "generic" });
  write(Profile.MesgNum.SESSION, { ...summary, event: "session", eventType: "stop", sport: sport.sport, subSport: sport.subSport ?? "generic", firstLapIndex: 0, numLaps: 1 });
  write(Profile.MesgNum.ACTIVITY, { timestamp: end, totalTimerTime: elapsed, numSessions: 1, type: "manual", event: "activity", eventType: "stop" });
  return encoder.close();
}

/** A tidy file name, e.g. "2021-05-03_0712_Run_Morning-run.fit" (in your local time). */
export function exportFileName(act: Activity, sportKey: string | null, used?: Set<string>): string {
  const d = new Date(act.start);
  const two = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}_${two(d.getHours())}${two(d.getMinutes())}`;
  const clean = (s: string) => s.normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const parts = [stamp, clean(sportKey ? sportLabel(sportKey) : "Activity"), act.title ? clean(act.title) : ""].filter(Boolean);
  let name = `${parts.join("_")}.fit`;
  for (let n = 2; used?.has(name); n++) name = `${parts.join("_")}_${n}.fit`;
  used?.add(name);
  return name;
}
