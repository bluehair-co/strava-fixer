import { describe, expect, it } from "vitest";
import { Decoder, Encoder, Profile, Stream } from "@garmin/fitsdk";
import { parseFit, reportedDistance, verifyFit, writeFit } from "./fit";
import { clearPositions, metresBetween, movePoint, straighten, trackLength } from "./track";

const toSemi = (deg: number) => Math.round((deg * 2 ** 31) / 180);

/** Builds a small but realistic activity with HR, cadence, power etc. */
function makeFit(): Uint8Array {
  const encoder = new Encoder();
  // The SDK's message types are stricter than these plain test objects.
  const write = (num: number, mesg: object) => encoder.onMesg(num, mesg as Parameters<Encoder["onMesg"]>[1]);
  const start = new Date("2026-10-01T08:00:00Z");
  write(Profile.MesgNum.FILE_ID, {
    type: "activity",
    manufacturer: "development",
    product: 1,
    timeCreated: start,
  });
  for (let i = 0; i < 20; i++) {
    const record: Record<string, unknown> = {
      timestamp: new Date(start.getTime() + i * 1000),
      heartRate: 120 + i,
      cadence: 85,
      power: 200 + i,
      altitude: 100 + i * 0.5,
      distance: i * 8,
      speed: 8,
      temperature: 18,
    };
    if (i !== 5) {
      // record 5 has no position, like a real GPS dropout
      record.positionLat = toSemi(52.37 + i * 0.0001);
      record.positionLong = toSemi(4.89 + i * 0.0001);
    }
    write(Profile.MesgNum.RECORD, record);
  }
  write(Profile.MesgNum.SESSION, {
    timestamp: new Date(start.getTime() + 20000),
    startTime: start,
    totalElapsedTime: 20,
    totalDistance: 160,
    sport: "cycling",
  });
  return encoder.close();
}

/**
 * 60 s ride heading east at 5 m/s, with a GPS glitch that jumps 200 m north
 * for points 20-24. Distance and speed are computed from GPS the way a watch
 * without a speed sensor would. Two laps of 30 s plus a session.
 */
function makeGlitchFit(): Uint8Array {
  const encoder = new Encoder();
  const write = (num: number, mesg: object) => encoder.onMesg(num, mesg as Parameters<Encoder["onMesg"]>[1]);
  const start = new Date("2026-10-01T08:00:00Z").getTime();
  const lat0 = 52.37;
  const lonStep = 5 / (111320 * Math.cos((lat0 * Math.PI) / 180)); // 5 m east
  const latGlitch = 200 / 111320; // 200 m north
  write(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer: "development", product: 1, timeCreated: new Date(start) });
  let cumulative = 0;
  let prev: [number, number] | null = null;
  const lapDist = [0, 0];
  const lapMax = [0, 0];
  for (let i = 0; i < 60; i++) {
    const lat = lat0 + (i >= 20 && i < 25 ? latGlitch : 0);
    const lon = 4.89 + i * lonStep;
    const step = prev ? metresBetween(prev[0], prev[1], lat, lon) : 0;
    cumulative += step;
    prev = [lat, lon];
    const lap = i < 30 ? 0 : 1;
    lapDist[lap] += step;
    lapMax[lap] = Math.max(lapMax[lap], step);
    write(Profile.MesgNum.RECORD, {
      timestamp: new Date(start + i * 1000),
      positionLat: toSemi(lat),
      positionLong: toSemi(lon),
      distance: cumulative,
      speed: step,
      enhancedSpeed: step,
      heartRate: 130 + (i % 7),
      cadence: 90,
    });
  }
  for (const lap of [0, 1]) {
    write(Profile.MesgNum.LAP, {
      timestamp: new Date(start + (lap * 30 + 29) * 1000),
      startTime: new Date(start + lap * 30 * 1000),
      totalElapsedTime: 30,
      totalTimerTime: 30,
      totalDistance: lapDist[lap],
      avgSpeed: lapDist[lap] / 30,
      maxSpeed: lapMax[lap],
      enhancedAvgSpeed: lapDist[lap] / 30,
      enhancedMaxSpeed: lapMax[lap],
    });
  }
  write(Profile.MesgNum.SESSION, {
    timestamp: new Date(start + 59000),
    startTime: new Date(start),
    totalElapsedTime: 60,
    totalTimerTime: 60,
    totalDistance: cumulative,
    avgSpeed: cumulative / 60,
    maxSpeed: Math.max(...lapMax),
    enhancedAvgSpeed: cumulative / 60,
    enhancedMaxSpeed: Math.max(...lapMax),
    sport: "cycling",
  });
  return encoder.close();
}

/** The i-th recorded distance value in a decoded file. */
function cumulativeAt(messages: Record<string, Record<string, unknown>[]>, i: number): number {
  return messages.recordMesgs.filter((r) => r.distance !== undefined)[i].distance as number;
}

function decode(bytes: Uint8Array) {
  const decoder = new Decoder(Stream.fromByteArray(Array.from(bytes)));
  expect(decoder.checkIntegrity()).toBe(true);
  const { messages, errors } = decoder.read();
  expect(errors).toEqual([]);
  // Loosely typed: the tests only compare plain values.
  return messages as unknown as Record<string, Record<string, unknown>[]>;
}

describe("FIT", () => {
  it("reads positions and times", () => {
    const parsed = parseFit(makeFit());
    // record 5 has no lat/long field at all, so it's not an editable point
    expect(parsed.points).toHaveLength(19);
    expect(parsed.points[0].lat).toBeCloseTo(52.37, 6);
    expect(parsed.points[0].lon).toBeCloseTo(4.89, 6);
    expect(parsed.points[1].time! - parsed.points[0].time!).toBe(1000);
    expect(new Date(parsed.points[0].time!).toISOString()).toBe("2026-10-01T08:00:00.000Z");
  });

  it("writes an untouched file back byte for byte", () => {
    const original = makeFit();
    const parsed = parseFit(original);
    const fixed = writeFit(original, parsed, parsed.points);
    expect(fixed).toEqual(original);
  });

  it("changes only positions, distance and speed when editing", () => {
    const original = makeFit();
    const parsed = parseFit(original);
    let points = movePoint(parsed.points, 3, 52.5, 4.95);
    points = straighten(points, 6, 10);
    points = clearPositions(points, 15, 16);
    const fixed = writeFit(original, parsed, points);

    expect(verifyFit(original, fixed, parsed)).toEqual([]);

    const before = decode(original);
    const after = decode(fixed);
    const strip = (r: Record<string, unknown>) => {
      // These are allowed to change; everything else must be identical.
      const { positionLat, positionLong, distance, speed, enhancedSpeed, ...rest } = r;
      void [positionLat, positionLong, distance, speed, enhancedSpeed];
      return rest;
    };
    expect(after.recordMesgs.map(strip)).toEqual(before.recordMesgs.map(strip));
    const stripSession = (r: Record<string, unknown>) => {
      const { totalDistance, avgSpeed, maxSpeed, enhancedAvgSpeed, enhancedMaxSpeed, ...rest } = r;
      void [totalDistance, avgSpeed, maxSpeed, enhancedAvgSpeed, enhancedMaxSpeed];
      return rest;
    };
    expect(after.sessionMesgs.map(stripSession)).toEqual(before.sessionMesgs.map(stripSession));
    expect(after.fileIdMesgs).toEqual(before.fileIdMesgs);

    // record 3 moved; records are offset by one after the position-less record 5
    expect(after.recordMesgs[3].positionLat).toBe(toSemi(52.5));
    expect(after.recordMesgs[3].positionLong).toBe(toSemi(4.95));
    // removed positions are absent in the decoded output
    expect(after.recordMesgs[16].positionLat).toBeUndefined();
    expect(after.recordMesgs[17].positionLong).toBeUndefined();

    const reparsed = parseFit(fixed);
    expect(reparsed.points[8].lat).toBeCloseTo((points[8].lat as number), 6);
  });

  it("recalculates distance and speed after fixing a GPS glitch", () => {
    const original = makeGlitchFit();
    const parsed = parseFit(original);
    expect(reportedDistance(original, parsed)!).toBeGreaterThan(600); // glitch adds ~400 m

    const fixedPoints = straighten(parsed.points, 19, 25);
    const fixed = writeFit(original, parsed, fixedPoints);
    expect(verifyFit(original, fixed, parsed)).toEqual([]);

    const before = decode(original);
    const after = decode(fixed);
    const session = after.sessionMesgs[0];
    // 59 steps of 5 m
    expect(session.totalDistance as number).toBeCloseTo(trackLength(fixedPoints), 0);
    expect(session.totalDistance as number).toBeCloseTo(295, 0);
    expect(session.avgSpeed as number).toBeCloseTo((session.totalDistance as number) / 60, 2);
    expect(session.maxSpeed as number).toBeCloseTo(5, 1); // the glitch's fake 40 m/s is gone

    // Laps add up to the session, and the first lap (which had the glitch) shrank.
    const laps = after.lapMesgs;
    expect((laps[0].totalDistance as number) + (laps[1].totalDistance as number)).toBeCloseTo(295, 0);
    expect(laps[1].totalDistance).toBe(before.lapMesgs[1].totalDistance);

    // Record distances keep increasing, and untouched records keep their speed.
    const dist = after.recordMesgs.map((r) => r.distance as number);
    for (let i = 1; i < dist.length; i++) expect(dist[i]).toBeGreaterThanOrEqual(dist[i - 1]);
    expect(dist[dist.length - 1]).toBeCloseTo(295, 0);
    expect(after.recordMesgs[5].speed).toBe(before.recordMesgs[5].speed);
    expect(after.recordMesgs[50].speed).toBe(before.recordMesgs[50].speed);
    expect(after.recordMesgs[22].speed as number).toBeCloseTo(5, 1);

    // Heart rate etc. untouched.
    expect(after.recordMesgs.map((r) => r.heartRate)).toEqual(before.recordMesgs.map((r) => r.heartRate));
  });

  it("handles files that keep distance in separate records (like Strava app recordings)", () => {
    // 120 s: ride 40 s east at 5 m/s, stand still 40 s (GPS wanders 30 m
    // around, so the recorded distance grows by ~150 m), then ride 40 s more.
    // Distance and heart rate are stored in their own records, and the lap
    // and session have no end timestamp, as in files from the Strava app.
    const encoder = new Encoder();
    const write = (num: number, mesg: object) => encoder.onMesg(num, mesg as Parameters<Encoder["onMesg"]>[1]);
    const start = new Date("2026-10-01T08:00:00Z").getTime();
    const lat0 = 52.37;
    const lonStep = 5 / (111320 * Math.cos((lat0 * Math.PI) / 180));
    write(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer: "strava", product: 201, timeCreated: new Date(start) });
    let cumulative = 0;
    let prev: [number, number] | null = null;
    for (let i = 0; i < 120; i++) {
      const moving = i < 40 ? i : i < 80 ? 40 : i - 40;
      const wander = i >= 40 && i < 80 ? (i % 2 ? 30 : -30) / 111320 : 0;
      const lat = lat0 + wander;
      const lon = 4.89 + moving * lonStep;
      const step = prev ? metresBetween(prev[0], prev[1], lat, lon) : 0;
      cumulative += step * 0.95; // the app smooths a little, so it's not exactly GPS
      prev = [lat, lon];
      const timestamp = new Date(start + i * 1000);
      write(Profile.MesgNum.RECORD, { timestamp, heartRate: 100 + (i % 30) });
      write(Profile.MesgNum.RECORD, { timestamp, distance: cumulative });
      write(Profile.MesgNum.RECORD, { timestamp, positionLat: toSemi(lat), positionLong: toSemi(lon), enhancedSpeed: step });
    }
    write(Profile.MesgNum.LAP, { startTime: new Date(start), totalTimerTime: 120, totalDistance: cumulative });
    write(Profile.MesgNum.SESSION, { startTime: new Date(start), totalTimerTime: 120, totalDistance: cumulative, sport: "cycling" });
    const original = encoder.close();

    const parsed = parseFit(original);
    expect(parsed.points).toHaveLength(120);
    // Put the standing-still points back where the rider actually was.
    const fixedPoints = straighten(parsed.points, 39, 80);
    const fixed = writeFit(original, parsed, fixedPoints);
    expect(verifyFit(original, fixed, parsed)).toEqual([]);

    const before = decode(original);
    const after = decode(fixed);
    const distances = after.recordMesgs.filter((r) => r.distance !== undefined).map((r) => r.distance as number);
    // Never goes backwards and has no sudden jumps.
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]);
      expect(distances[i] - distances[i - 1]).toBeLessThan(6);
    }
    // Riding parts keep the app's own distance per step; standing still adds ~0.
    const at = (i: number) => distances[i];
    expect(at(39)).toBeCloseTo(cumulativeAt(before, 39), 1);
    expect(at(80) - at(39)).toBeCloseTo(5, 0); // just the one real 5 m step
    expect(at(119) - at(80)).toBeCloseTo(cumulativeAt(before, 119) - cumulativeAt(before, 80), 1);
    // Lap and session totals follow, even without end timestamps.
    expect(after.sessionMesgs[0].totalDistance as number).toBeCloseTo(at(119), 1);
    expect(after.lapMesgs[0].totalDistance as number).toBeCloseTo(at(119), 1);
    expect(before.sessionMesgs[0].totalDistance as number).toBeGreaterThan(at(119) + 100);
    // Heart rate untouched, sample for sample.
    expect(after.recordMesgs.map((r) => r.heartRate)).toEqual(before.recordMesgs.map((r) => r.heartRate));
  });

  it("flags changes outside position fields", () => {
    const original = makeFit();
    const parsed = parseFit(original);
    const fixed = writeFit(original, parsed, parsed.points);
    fixed[20] ^= 0xff;
    expect(verifyFit(original, fixed, parsed).length).toBeGreaterThan(0);
  });

  it("handles compressed timestamps", () => {
    // Hand-built file: definition for a record with lat/long only, then two
    // data messages using compressed-timestamp headers.
    const def = [0x40, 0, 0, 20, 0, 2, 0, 4, 0x85, 1, 4, 0x85];
    // A timestamp-carrying record so compressed headers have a base time.
    const defTs = [0x41, 0, 0, 20, 0, 3, 253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85];
    const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
    const data = [
      ...defTs,
      0x01, ...le32(1000), ...le32(toSemi(10)), ...le32(toSemi(20)),
      ...def,
      0x80 | (0 << 5) | ((1000 + 3) & 0x1f), ...le32(toSemi(11)), ...le32(toSemi(21)),
    ];
    const header = [14, 0x20, 0, 0, ...le32(data.length), 0x2e, 0x46, 0x49, 0x54, 0, 0];
    const bytes = new Uint8Array([...header, ...data, 0, 0]);
    const parsed = parseFit(bytes);
    expect(parsed.points).toHaveLength(2);
    expect(parsed.points[1].time! - parsed.points[0].time!).toBe(3000);
    expect(parsed.points[1].lat).toBeCloseTo(11, 6);
  });
});
