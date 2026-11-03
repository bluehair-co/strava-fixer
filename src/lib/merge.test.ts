import { describe, expect, it } from "vitest";
import { Decoder, Encoder, Profile, Stream } from "@garmin/fitsdk";
import { parseFit } from "./fit";
import { parseGpx } from "./gpx";
import { addPositionFields, mergeActivities, positionsAt, verifyMergedFit } from "./merge";
import { trackLength, type TrackPoint } from "./track";

const toSemi = (deg: number) => Math.round((deg * 2 ** 31) / 180);
const START = new Date("2026-10-01T08:00:00Z").getTime();
const LAT0 = 52.37;
const LON_STEP = 5 / (111320 * Math.cos((LAT0 * Math.PI) / 180)); // 5 m east

/** Where the rider really was after `s` seconds: heading east at 5 m/s. */
const truth = (s: number) => ({ lat: LAT0, lon: 4.89 + s * LON_STEP });

/** The phone's recording: a position every 2 s for the whole 60 s. */
function phoneTrack(): TrackPoint[] {
  const pts: TrackPoint[] = [];
  for (let s = 0; s <= 60; s += 2) pts.push({ ...truth(s), time: START + s * 1000 });
  return pts;
}

/**
 * A watch recording of the same 60 s with heart rate, cadence, power and a
 * (wrist-measured, so too short) distance. GPS is only found after
 * `gpsFrom` seconds; before that, samples have no position fields at all.
 * When it has GPS, it's 30 m off to the north.
 */
function watchFit(gpsFrom = Infinity): Uint8Array {
  const encoder = new Encoder();
  const write = (num: number, mesg: object) => encoder.onMesg(num, mesg as Parameters<Encoder["onMesg"]>[1]);
  write(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer: "development", product: 1, timeCreated: new Date(START) });
  for (let s = 0; s < 60; s++) {
    const record: Record<string, unknown> = {
      timestamp: new Date(START + s * 1000),
      heartRate: 120 + (s % 11),
      cadence: 85 + (s % 3),
      power: 200 + s,
      altitude: 10 + s * 0.1,
      distance: s * 4,
      speed: 4,
      temperature: 18,
    };
    if (s >= gpsFrom) {
      record.positionLat = toSemi(truth(s).lat + 30 / 111320);
      record.positionLong = toSemi(truth(s).lon);
    }
    write(Profile.MesgNum.RECORD, record);
  }
  write(Profile.MesgNum.LAP, {
    timestamp: new Date(START + 59000),
    startTime: new Date(START),
    totalElapsedTime: 60,
    totalTimerTime: 60,
    totalDistance: 236,
    avgSpeed: 236 / 60,
    maxSpeed: 4,
  });
  write(Profile.MesgNum.SESSION, {
    timestamp: new Date(START + 59000),
    startTime: new Date(START),
    totalElapsedTime: 60,
    totalTimerTime: 60,
    totalDistance: 236,
    avgSpeed: 236 / 60,
    maxSpeed: 4,
    avgHeartRate: 125,
    sport: "running",
  });
  return encoder.close();
}

function decode(bytes: Uint8Array) {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  expect(decoder.checkIntegrity()).toBe(true);
  const { messages, errors } = decoder.read();
  expect(errors).toEqual([]);
  return messages as unknown as Record<string, Record<string, unknown>[]>;
}

/** Everything in a record except the values a merge may change. */
const sensors = (r: Record<string, unknown>) => {
  const { positionLat, positionLong, distance, speed, enhancedSpeed, ...rest } = r;
  void [positionLat, positionLong, distance, speed, enhancedSpeed];
  return rest;
};

describe("merging two recordings", () => {
  it("interpolates the GPS recording at the other file's times", () => {
    const at = positionsAt(phoneTrack(), [START + 3000, START + 4000, START - 1000, START + 61000, null]);
    expect(at[0]!.lon).toBeCloseTo(truth(3).lon, 9);
    expect(at[1]!.lon).toBeCloseTo(truth(4).lon, 9);
    expect(at.slice(2)).toEqual([null, null, null]);
  });

  it("gives a watch without GPS the phone's track, keeping all its sensor data", () => {
    const watch = watchFit();
    expect(parseFit(watch).points).toHaveLength(0); // no position fields at all

    const result = mergeActivities(watch, phoneTrack(), "replace");
    expect(result.kind).toBe("fit");
    expect(result.problems).toEqual([]);
    expect(result.changed).toBe(60);
    expect(result.missing).toBe(0);

    const before = decode(watch);
    const after = decode(result.data);
    expect(after.recordMesgs.map(sensors)).toEqual(before.recordMesgs.map(sensors));
    expect(after.fileIdMesgs).toEqual(before.fileIdMesgs);
    expect(after.sessionMesgs[0].avgHeartRate).toBe(125);
    expect(after.recordMesgs[17].positionLong).toBe(toSemi(truth(17).lon));

    // Distance now comes from the phone's track: 59 steps of 5 m, not the
    // watch's 236 m.
    const reparsed = parseFit(result.data);
    expect(trackLength(reparsed.points)).toBeCloseTo(295, 0);
    expect(after.sessionMesgs[0].totalDistance as number).toBeCloseTo(295, 0);
    expect(after.lapMesgs[0].totalDistance as number).toBeCloseTo(295, 0);
    expect(after.recordMesgs[59].distance as number).toBeCloseTo(295, 0);
    expect(after.recordMesgs[30].speed as number).toBeCloseTo(5, 1);
  });

  it("can fill only the part where the watch had no GPS", () => {
    const watch = watchFit(20);
    const result = mergeActivities(watch, phoneTrack(), "fill");
    expect(result.problems).toEqual([]);
    expect(result.changed).toBe(20);
    const after = decode(result.data);
    expect(after.recordMesgs[5].positionLong).toBe(toSemi(truth(5).lon));
    // From 20 s on, the watch's own (offset) positions are kept.
    expect(after.recordMesgs[40].positionLat).toBe(decode(watch).recordMesgs[40].positionLat);

    const replaced = mergeActivities(watch, phoneTrack(), "replace");
    expect(replaced.changed).toBe(60);
    expect(decode(replaced.data).recordMesgs[40].positionLat).toBe(toSemi(LAT0));
  });

  it("leaves samples outside the phone's recording without a position", () => {
    const phone = phoneTrack().filter((p) => p.time! >= START + 10_000);
    const result = mergeActivities(watchFit(), phone, "replace");
    expect(result.problems).toEqual([]);
    expect(result.missing).toBe(10);
    expect(decode(result.data).recordMesgs[5].positionLat).toBeUndefined();
  });

  it("refuses recordings that don't overlap", () => {
    const later = phoneTrack().map((p) => ({ ...p, time: p.time! + 3_600_000 }));
    expect(() => mergeActivities(watchFit(), later, "replace")).toThrow(/overlap/);
  });

  it("flags any change other than positions, distance and speed", () => {
    const watch = watchFit();
    const result = mergeActivities(watch, phoneTrack(), "replace");
    const tampered = new Uint8Array(result.data);
    // Find a heart rate value (120) in the first record and change it.
    const at = tampered.indexOf(120, 60);
    tampered[at] = 99;
    expect(verifyMergedFit(watch, tampered).length).toBeGreaterThan(0);
  });

  it("doesn't change a file that already has position fields", () => {
    const watch = watchFit(0);
    expect(addPositionFields(watch)).toBe(watch);
  });

  it("doesn't put positions on samples that only carry heart rate (Strava app style)", () => {
    const encoder = new Encoder();
    const write = (num: number, mesg: object) => encoder.onMesg(num, mesg as Parameters<Encoder["onMesg"]>[1]);
    write(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer: "strava", product: 201, timeCreated: new Date(START) });
    for (let s = 0; s < 20; s++) {
      const timestamp = new Date(START + s * 1000);
      write(Profile.MesgNum.RECORD, { timestamp, heartRate: 100 + s });
      // GPS was lost for the first 10 s, so the position is "invalid".
      write(Profile.MesgNum.RECORD, {
        timestamp,
        positionLat: s < 10 ? 0x7fffffff : toSemi(truth(s).lat),
        positionLong: s < 10 ? 0x7fffffff : toSemi(truth(s).lon),
      });
    }
    const original = encoder.close();
    const result = mergeActivities(original, phoneTrack(), "fill");
    expect(result.problems).toEqual([]);
    expect(result.changed).toBe(10);
    const after = decode(result.data);
    expect(after.recordMesgs[0].positionLat).toBeUndefined(); // heart rate sample
    expect(after.recordMesgs[1].positionLong).toBe(toSemi(truth(0).lon));
    expect(after.recordMesgs.filter((r) => r.heartRate !== undefined).map((r) => r.heartRate)).toEqual(
      decode(original).recordMesgs.filter((r) => r.heartRate !== undefined).map((r) => r.heartRate),
    );
  });

  it("works with a GPX file as the base", () => {
    const pts = [0, 1, 2, 3].map(
      (s) =>
        `<trkpt lat="52.38" lon="4.9"><ele>3</ele><time>${new Date(START + s * 1000).toISOString()}</time>` +
        `<extensions><hr>${130 + s}</hr></extensions></trkpt>`,
    );
    const gpx = `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${pts.join("")}</trkseg></trk></gpx>`;
    const result = mergeActivities(new TextEncoder().encode(gpx), phoneTrack(), "replace");
    expect(result.kind).toBe("gpx");
    expect(result.problems).toEqual([]);
    const text = new TextDecoder().decode(result.data);
    expect(text).toContain("<hr>133</hr>");
    expect(parseGpx(text).points[3].lon).toBeCloseTo(truth(3).lon, 7);
  });
});
