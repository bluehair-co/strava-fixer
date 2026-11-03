import { describe, expect, it } from "vitest";
import { Decoder, Encoder, Profile, Stream } from "@garmin/fitsdk";
import { joinActivities, verifyJoinedFit } from "./join";
import { parseGpx } from "./gpx";

const toSemi = (deg: number) => Math.round((deg * 2 ** 31) / 180);
const START = new Date("2026-10-01T08:00:00Z").getTime();
const LAT0 = 52.37;
const LON_STEP = 5 / (111320 * Math.cos((LAT0 * Math.PI) / 180)); // 5 m east

/** A 30 s recording heading east at 5 m/s, starting `from` s after START. */
function part(from: number, manufacturer: string): Uint8Array {
  const encoder = new Encoder();
  const write = (num: number, mesg: object) => encoder.onMesg(num, mesg as Parameters<Encoder["onMesg"]>[1]);
  write(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer, product: 1, timeCreated: new Date(START + from * 1000) });
  for (let s = 0; s < 30; s++) {
    write(Profile.MesgNum.RECORD, {
      timestamp: new Date(START + (from + s) * 1000),
      positionLat: toSemi(LAT0),
      positionLong: toSemi(4.89 + (from + s) * LON_STEP),
      distance: s * 5,
      heartRate: 120 + s,
    });
  }
  write(Profile.MesgNum.SESSION, {
    timestamp: new Date(START + (from + 29) * 1000),
    startTime: new Date(START + from * 1000),
    totalElapsedTime: 30,
    totalTimerTime: 30,
    totalDistance: 145,
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

describe("joining recordings made one after the other", () => {
  it("puts two FIT files together in time order and continues the distance", () => {
    const watch = part(0, "garmin");
    const phone = part(60, "strava"); // a 30 s gap: 30 s × 5 m/s = 150 m walked
    // Given in the wrong order on purpose: the app sorts them by time.
    const result = joinActivities(phone, watch);
    expect(result.kind).toBe("fit");
    expect(result.firstIndex).toBe(1);
    expect(result.gapMinutes).toBeCloseTo(31 / 60, 5);
    expect(result.problems).toEqual([]);

    const joined = decode(result.data);
    expect(joined.fileIdMesgs).toHaveLength(1);
    expect(joined.fileIdMesgs[0].manufacturer).toBe("garmin");
    expect(joined.recordMesgs).toHaveLength(60);
    expect(joined.sessionMesgs).toHaveLength(2);
    // Heart rate and times are untouched.
    expect(joined.recordMesgs.map((r) => r.heartRate)).toEqual([
      ...decode(watch).recordMesgs.map((r) => r.heartRate),
      ...decode(phone).recordMesgs.map((r) => r.heartRate),
    ]);
    const d = joined.recordMesgs.map((r) => r.distance as number);
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeGreaterThanOrEqual(d[i - 1]);
    // 145 m in the first part + 155 m straight across the gap.
    expect(d[30]).toBeCloseTo(300, 0);
    expect(d[59]).toBeCloseTo(445, 0);
    expect(result.points).toHaveLength(60);
  });

  it("refuses recordings that overlap", () => {
    expect(() => joinActivities(part(0, "garmin"), part(20, "strava"))).toThrow(/overlap/);
  });

  it("refuses a FIT and a GPX together", () => {
    const gpx = new TextEncoder().encode('<gpx version="1.1"><trk><trkseg></trkseg></trk></gpx>');
    expect(() => joinActivities(part(0, "garmin"), gpx)).toThrow(/same kind/);
  });

  it("flags a change to anything but the second part's distance", () => {
    const a = part(0, "garmin");
    const b = part(60, "strava");
    const result = joinActivities(a, b);
    const tampered = new Uint8Array(result.data);
    tampered[tampered.length - 40] ^= 0x01;
    expect(verifyJoinedFit(a, b, tampered).length).toBeGreaterThan(0);
  });

  it("joins two GPX files, keeping every point as written", () => {
    const gpx = (from: number, ns: string) => {
      const pts = [0, 1, 2].map(
        (s) =>
          `<trkpt lat="52.37" lon="${(4.89 + (from + s) * LON_STEP).toFixed(7)}"><time>${new Date(START + (from + s) * 1000).toISOString()}</time>` +
          `<extensions><${ns}:hr>${130 + s}</${ns}:hr></extensions></trkpt>`,
      );
      return `<?xml version="1.0"?>\n<gpx version="1.1" xmlns:${ns}="urn:${ns}"><trk><name>Run</name><trkseg>${pts.join("")}</trkseg></trk></gpx>`;
    };
    const first = gpx(0, "a");
    const second = gpx(100, "b");
    const result = joinActivities(new TextEncoder().encode(first), new TextEncoder().encode(second));
    expect(result.kind).toBe("gpx");
    expect(result.problems).toEqual([]);
    const text = new TextDecoder().decode(result.data);
    expect(parseGpx(text).points).toHaveLength(6);
    expect(text).toContain('xmlns:b="urn:b"');
    expect(text).toContain("<b:hr>132</b:hr>");
    expect(text).toContain("<name>Run</name>");
  });
});
