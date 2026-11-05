import { describe, expect, it } from "vitest";
import { Decoder, Encoder, Profile, Stream } from "@garmin/fitsdk";
import { cropFile, cropFit, keptRange, verifyCroppedFit, verifyCroppedGpx } from "./crop";
import { readMessages } from "./fitbytes";
import { parseGpx } from "./gpx";
import { loadActivityBytes, type LoadedActivity } from "./activity";
import { insertPoint, movePoint } from "./track";
import { buildCombined, defaultChoices, planCombine } from "./combine";
import { readSource } from "./sources";

const toSemi = (deg: number) => Math.round((deg * 2 ** 31) / 180);
const START = new Date("2026-10-01T08:00:00Z").getTime();
const at = (s: number) => new Date(START + s * 1000);

/**
 * 100 s of riding at 5 m/s, with two laps (0–49 s, 50–99 s), a pause from
 * 20 to 30 s and heart rate on every sample.
 */
function ride(): Uint8Array {
  const encoder = new Encoder();
  const write = (num: number, mesg: object) => encoder.onMesg(num, mesg as Parameters<Encoder["onMesg"]>[1]);
  write(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer: "development", product: 1, timeCreated: at(0) });
  write(Profile.MesgNum.EVENT, { timestamp: at(0), event: "timer", eventType: "start" });
  for (let s = 0; s < 100; s++) {
    if (s === 20) write(Profile.MesgNum.EVENT, { timestamp: at(20), event: "timer", eventType: "stop" });
    if (s === 30) write(Profile.MesgNum.EVENT, { timestamp: at(30), event: "timer", eventType: "start" });
    write(Profile.MesgNum.RECORD, {
      timestamp: at(s),
      positionLat: toSemi(52.37),
      positionLong: toSemi(4.89 + s * 0.0001),
      distance: s * 5,
      speed: 5,
      heartRate: 100 + s,
      altitude: 10 + s,
    });
    if (s === 49) {
      write(Profile.MesgNum.LAP, {
        timestamp: at(49), startTime: at(0), totalElapsedTime: 49, totalTimerTime: 39, totalDistance: 245, avgSpeed: 245 / 39, maxSpeed: 5, avgHeartRate: 124,
      });
    }
  }
  write(Profile.MesgNum.EVENT, { timestamp: at(99), event: "timer", eventType: "stopAll" });
  write(Profile.MesgNum.LAP, {
    timestamp: at(99), startTime: at(50), totalElapsedTime: 49, totalTimerTime: 49, totalDistance: 245, avgSpeed: 5, maxSpeed: 5, avgHeartRate: 174,
  });
  write(Profile.MesgNum.SESSION, {
    timestamp: at(99), startTime: at(0), totalElapsedTime: 99, totalTimerTime: 89, totalDistance: 495, avgSpeed: 495 / 89, maxSpeed: 5, numLaps: 2, sport: "cycling", avgHeartRate: 150,
  });
  write(Profile.MesgNum.ACTIVITY, { timestamp: at(99), totalTimerTime: 89, numSessions: 1, type: "manual", event: "activity", eventType: "stop" });
  return encoder.close();
}

function decode(bytes: Uint8Array) {
  const { messages, errors } = new Decoder(Stream.fromByteArray(Array.from(bytes))).read();
  expect(errors).toEqual([]);
  return messages as unknown as Record<string, Record<string, unknown>[]>;
}

describe("cropping a FIT file", () => {
  it("removes the samples before the new start and counts distance from there", () => {
    const original = ride();
    const { data, problems } = cropFile(original, { start: START + 10_000, end: null });
    expect(problems).toEqual([]);
    const m = decode(data);
    expect(m.recordMesgs).toHaveLength(90);
    expect((m.recordMesgs[0].timestamp as Date).getTime()).toBe(START + 10_000);
    // Sensor data is untouched.
    expect(m.recordMesgs[0].heartRate).toBe(110);
    expect(m.recordMesgs[0].altitude).toBeCloseTo(20);
    expect(m.recordMesgs[0].distance).toBe(0);
    expect(m.recordMesgs[89].distance).toBe(445);

    const session = m.sessionMesgs[0];
    expect((session.startTime as Date).getTime()).toBe(START + 10_000);
    expect(session.totalElapsedTime).toBe(89);
    expect(session.totalTimerTime).toBe(79); // the pause wasn't cropped
    expect(session.totalDistance).toBe(445);
    expect(session.avgHeartRate).toBe(150); // never recalculated
    expect(m.lapMesgs).toHaveLength(2);
    expect(m.lapMesgs[0].totalDistance).toBe(195);
  });

  it("removes laps that are wholly cut off and counts timer time without pauses", () => {
    const original = ride();
    const { data, problems } = cropFile(original, { start: START + 55_000, end: START + 90_000 });
    expect(problems).toEqual([]);
    const m = decode(data);
    expect(m.recordMesgs).toHaveLength(36);
    expect(m.lapMesgs).toHaveLength(1);
    expect(m.sessionMesgs[0].numLaps).toBe(1);
    expect(m.sessionMesgs[0].totalElapsedTime).toBe(35);
    // 55 s were cut from the start, 10 of which were paused; 9 from the end.
    expect(m.sessionMesgs[0].totalTimerTime).toBe(89 - 45 - 9);
    expect(m.sessionMesgs[0].totalDistance).toBe(175);
    expect((m.sessionMesgs[0].timestamp as Date).getTime()).toBe(START + 90_000);
    expect(m.activityMesgs).toHaveLength(1);
  });

  it("refuses to crop everything away", () => {
    expect(() => cropFit(ride(), { start: START + 200_000, end: null })).toThrow(/nothing/);
  });

  it("safety check catches changed sensor data and leftover samples", () => {
    const original = ride();
    const crop = { start: START + 10_000, end: null };
    // Keeping everything is not a valid crop.
    expect(verifyCroppedFit(original, original, crop).length).toBeGreaterThan(0);

    const cropped = cropFit(original, crop);
    expect(verifyCroppedFit(original, cropped, crop)).toEqual([]);
    // Change one heart rate value (and fix the checksum, so only the value is wrong).
    const hrAt = findField(cropped, 20, 3);
    const tampered = new Uint8Array(cropped);
    tampered[hrAt] += 1;
    expect(verifyCroppedFit(original, refreshCrc(tampered), crop).join(" ")).toMatch(/changed a value/);
  });

  it("keeps the messages it doesn't crop, in order", () => {
    const original = ride();
    const before = readMessages(original);
    const after = readMessages(cropFit(original, { start: null, end: START + 49_000 }));
    expect(after.filter((m) => m.globalNum === 20)).toHaveLength(50);
    expect(after.filter((m) => m.globalNum === 21)).toEqual(before.filter((m) => m.globalNum === 21));
    expect(after.filter((m) => m.globalNum === 19)).toHaveLength(1);
  });
});

/** Byte offset of the first record's field `num` (1 byte) in a file made by the SDK encoder. */
function findField(bytes: Uint8Array, mesg: number, num: number): number {
  const defs = new Map<number, { global: number; fields: [number, number][] }>();
  let pos = bytes[0];
  for (;;) {
    const h = bytes[pos++];
    if (h & 0x40) {
      const global = bytes[pos + 2] | (bytes[pos + 3] << 8);
      const n = bytes[pos + 4];
      const fields: [number, number][] = [];
      for (let i = 0; i < n; i++) fields.push([bytes[pos + 5 + i * 3], bytes[pos + 6 + i * 3]]);
      defs.set(h & 0x0f, { global, fields });
      pos += 5 + n * 3;
      continue;
    }
    const def = defs.get(h & 0x0f)!;
    let at = pos;
    for (const [f, size] of def.fields) {
      if (def.global === mesg && f === num) return at;
      at += size;
    }
    pos = at;
  }
}

function refreshCrc(bytes: Uint8Array): Uint8Array {
  // Same algorithm as fitbytes.fitCrc.
  const table = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
  let crc = 0;
  for (let i = 0; i < bytes.length - 2; i++) {
    for (const nib of [bytes[i] & 0xf, bytes[i] >> 4]) {
      const tmp = table[crc & 0xf];
      crc = ((crc >> 4) & 0x0fff) ^ tmp ^ table[nib];
    }
  }
  bytes[bytes.length - 2] = crc & 0xff;
  bytes[bytes.length - 1] = crc >> 8;
  return bytes;
}

const GPX = `<?xml version="1.0"?>
<gpx version="1.1" creator="test"><metadata><time>2026-10-01T08:00:00Z</time></metadata><trk><name>Walk</name><trkseg>
   <trkpt lat="52.37" lon="4.89"><ele>3</ele><time>2026-10-01T08:00:00Z</time></trkpt>
   <trkpt lat="52.371" lon="4.89"><ele>4</ele><time>2026-10-01T08:00:10Z</time></trkpt>
   <trkpt lat="52.372" lon="4.89"><ele>5</ele><time>2026-10-01T08:00:20Z</time></trkpt>
   <trkpt lat="52.373" lon="4.89"><ele>6</ele><time>2026-10-01T08:00:30Z</time></trkpt>
  </trkseg></trk></gpx>`;

describe("cropping a GPX file", () => {
  it("removes whole track points and keeps everything else", () => {
    const crop = { start: START + 10_000, end: START + 20_000 };
    const { data, problems } = cropFile(new TextEncoder().encode(GPX), crop);
    expect(problems).toEqual([]);
    const text = new TextDecoder().decode(data);
    expect(parseGpx(text).points.map((p) => p.lat)).toEqual([52.371, 52.372]);
    expect(text).toContain(`<trkpt lat="52.371" lon="4.89"><ele>4</ele><time>2026-10-01T08:00:10Z</time></trkpt>`);
    expect(text).toContain("<name>Walk</name>");
  });

  it("safety check catches a changed point", () => {
    const crop = { start: START + 10_000, end: null };
    const good = new TextDecoder().decode(cropFile(new TextEncoder().encode(GPX), crop).data);
    expect(verifyCroppedGpx(GPX, good, crop)).toEqual([]);
    expect(verifyCroppedGpx(GPX, good.replace("<ele>5</ele>", "<ele>9</ele>"), crop)).not.toEqual([]);
    expect(verifyCroppedGpx(GPX, GPX, crop)).not.toEqual([]);
  });
});

describe("kept range", () => {
  it("finds the first and last point inside the crop", () => {
    const pts = [0, 10, 20, 30].map((s) => ({ lat: 1, lon: 1, time: START + s * 1000 }));
    expect(keptRange(pts, { start: START + 5000, end: START + 20_000 })).toEqual([1, 2]);
    expect(keptRange(pts, { start: START + 50_000, end: null })).toBeNull();
  });
});

describe("cropping after fixing", () => {
  it("crops a FIT file with moved and added points, and reports the cropped distance", () => {
    const activity = loadActivityBytes("ride.fit", ride()) as LoadedActivity;
    let points = movePoint(activity.points, 40, 52.3705, 4.894);
    points = insertPoint(points, 60, 52.3702, 4.896);
    const crop = { start: START + 10_000, end: START + 80_000 };
    const { data, problems } = activity.build(points, crop);
    expect(problems).toEqual([]);
    const m = decode(data);
    expect(m.recordMesgs).toHaveLength(72); // 71 recorded + 1 added
    expect(m.recordMesgs[0].distance).toBe(0);
    expect(activity.distance(points, crop)).toBe(m.sessionMesgs[0].totalDistance);
    expect(activity.distance(points, crop)!).toBeLessThan(activity.distance(points)!);
  });

  it("crops a GPX file with an added point", () => {
    const activity = loadActivityBytes("walk.gpx", new TextEncoder().encode(GPX)) as LoadedActivity;
    const points = insertPoint(activity.points, 1, 52.3715, 4.8901);
    const { data, problems } = activity.build(points, { start: START + 10_000, end: null });
    expect(problems).toEqual([]);
    expect(parseGpx(new TextDecoder().decode(data)).points).toHaveLength(4);
  });
});

describe("cropping a combined file", () => {
  it("crops the result of combining two files", () => {
    const sources = [readSource("a.fit", ride()), readSource("b.gpx", new TextEncoder().encode(GPX))];
    const choices = defaultChoices(sources);
    const result = buildCombined(sources, choices, planCombine(sources, choices));
    expect(result.problems).toEqual([]);
    const { problems } = cropFile(result.data, { start: START + 5000, end: START + 25_000 });
    expect(problems).toEqual([]);
  });
});
