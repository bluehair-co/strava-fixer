import { describe, expect, it } from "vitest";
import { Decoder, Encoder, Profile, Stream } from "@garmin/fitsdk";
import { parseFit, verifyFit, writeFit } from "./fit";
import { clearPositions, movePoint, straighten } from "./track";

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

  it("changes only positions when editing", () => {
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
      const { positionLat, positionLong, ...rest } = r;
      void positionLat;
      void positionLong;
      return rest;
    };
    expect(after.recordMesgs.map(strip)).toEqual(before.recordMesgs.map(strip));
    expect(after.sessionMesgs).toEqual(before.sessionMesgs);
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
