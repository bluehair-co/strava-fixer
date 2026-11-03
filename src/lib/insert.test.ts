import { describe, expect, it } from "vitest";
import { Decoder, Encoder, Profile, Stream } from "@garmin/fitsdk";
import { parseFit, reportedDistance, verifyFit, writeFit } from "./fit";
import { parseGpx, verifyGpx, writeGpx } from "./gpx";
import {
  clearPositions,
  countChanged,
  deleteAdded,
  insertPoint,
  metresBetween,
  movePoint,
  retime,
  type TrackPoint,
} from "./track";

const toSemi = (deg: number) => Math.round((deg * 2 ** 31) / 180);
const T0 = Date.parse("2026-10-01T08:00:00Z");

/** Two points 100 m apart (east), 9 s apart, plus one more. */
function line(): TrackPoint[] {
  const lonStep = 100 / (111320 * Math.cos((52.37 * Math.PI) / 180));
  return [
    { lat: 52.37, lon: 4.89, time: T0 },
    { lat: 52.37, lon: 4.89 + lonStep, time: T0 + 9000 },
    { lat: 52.37, lon: 4.89 + 2 * lonStep, time: T0 + 18000 },
  ];
}

describe("added point times", () => {
  it("gives a point a third of the way along a time a third of the way", () => {
    const pts = line();
    const third = { lat: 52.37, lon: pts[0].lon! + (pts[1].lon! - pts[0].lon!) / 3 };
    const out = insertPoint(pts, 0, third.lat, third.lon);
    expect(out).toHaveLength(4);
    expect(out[1].added).toBe(true);
    expect(out[1].time).toBe(T0 + 3000);
    // Recorded times never change.
    expect(out.filter((p) => !p.added).map((p) => p.time)).toEqual(pts.map((p) => p.time));
  });

  it("recalculates when the point is moved", () => {
    const pts = line();
    let out = insertPoint(pts, 0, 52.37, pts[0].lon! + (pts[1].lon! - pts[0].lon!) / 3);
    out = movePoint(out, 1, 52.37, pts[0].lon! + ((pts[1].lon! - pts[0].lon!) * 2) / 3);
    expect(out[1].time).toBe(T0 + 6000);
  });

  it("recalculates when the recorded point next to it is moved", () => {
    const pts = line();
    let out = insertPoint(pts, 0, 52.37, pts[0].lon! + (pts[1].lon! - pts[0].lon!) / 3);
    // Move the start onto the added point's spot: it's now at the very start of the way.
    out = movePoint(out, 0, 52.37, out[1].lon!);
    expect(out[1].time).toBe(T0);
  });

  it("shares the time by distance along the way when several points are added", () => {
    const pts = line();
    const dLon = pts[1].lon! - pts[0].lon!;
    let out = insertPoint(pts, 0, 52.37, pts[0].lon! + dLon / 3); // 1/3
    expect(out[1].time).toBe(T0 + 3000);
    // A detour point: the way A -> added1 -> detour -> B is now longer.
    const detourLat = 52.37 + 100 / 111320; // ~100 m north
    out = insertPoint(out, 1, detourLat, pts[0].lon! + (2 * dLon) / 3);
    const a = out[0];
    const legs = [
      metresBetween(a.lat!, a.lon!, out[1].lat!, out[1].lon!),
      metresBetween(out[1].lat!, out[1].lon!, out[2].lat!, out[2].lon!),
      metresBetween(out[2].lat!, out[2].lon!, out[3].lat!, out[3].lon!),
    ];
    const total = legs[0] + legs[1] + legs[2];
    const expected = (share: number) => Math.round((T0 + 9000 * share) / 1000) * 1000;
    expect(out[1].time).toBe(expected(legs[0] / total));
    expect(out[2].time).toBe(expected((legs[0] + legs[1]) / total));
    expect(out[1].time!).toBeLessThan(out[2].time!);
  });

  it("counts and deletes added points, and drops ones that lose a neighbour", () => {
    const pts = line();
    let out = insertPoint(pts, 0, 52.37, pts[0].lon! + 0.0003);
    out = insertPoint(out, 2, 52.37, pts[1].lon! + 0.0003);
    expect(countChanged(pts, out)).toEqual({ moved: 0, added: 2 });
    expect(deleteAdded(out, 0, 1)).toHaveLength(4);
    // Removing the GPS of the recorded point between them removes both added points.
    const cleared = clearPositions(out, 2, 2);
    expect(cleared.filter((p) => p.added)).toHaveLength(0);
    expect(cleared).toHaveLength(3);
  });

  it("leaves tracks without added points alone", () => {
    const pts = line();
    expect(retime(pts)).toBe(pts);
  });
});

/** 20 s ride east at 5 m/s, with HR, cadence, power, altitude, distance and speed. */
function makeFit(): Uint8Array {
  const encoder = new Encoder();
  const write = (num: number, mesg: object) => encoder.onMesg(num, mesg as Parameters<Encoder["onMesg"]>[1]);
  const lonStep = 5 / (111320 * Math.cos((52.37 * Math.PI) / 180));
  write(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer: "development", product: 1, timeCreated: new Date(T0) });
  // A GPS gap: no samples between 5 s and 14 s.
  const times = [0, 1, 2, 3, 4, 5, 14, 15, 16, 17, 18, 19];
  for (const s of times) {
    write(Profile.MesgNum.RECORD, {
      timestamp: new Date(T0 + s * 1000),
      positionLat: toSemi(52.37),
      positionLong: toSemi(4.89 + s * lonStep),
      distance: s * 5,
      speed: 5,
      heartRate: 120 + s,
      cadence: 85,
      power: 200 + s,
      altitude: 100 + s,
    });
  }
  write(Profile.MesgNum.LAP, {
    timestamp: new Date(T0 + 19000),
    startTime: new Date(T0),
    totalElapsedTime: 19,
    totalTimerTime: 19,
    totalDistance: 95,
    avgSpeed: 5,
  });
  write(Profile.MesgNum.SESSION, {
    timestamp: new Date(T0 + 19000),
    startTime: new Date(T0),
    totalElapsedTime: 19,
    totalTimerTime: 19,
    totalDistance: 95,
    avgSpeed: 5,
    sport: "cycling",
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

describe("FIT with added points", () => {
  it("adds new samples with only time, position, distance and speed", () => {
    const original = makeFit();
    const parsed = parseFit(original);
    // Point 5 is at 5 s, point 6 at 14 s. The rider actually went 50 m north
    // and back in that gap; add the corner a third of the way.
    const p5 = parsed.points[5];
    const p6 = parsed.points[6];
    const north = 52.37 + 50 / 111320;
    let points = insertPoint(parsed.points, 5, north, p5.lon! + (p6.lon! - p5.lon!) / 2);
    points = insertPoint(points, 6, north, p5.lon! + ((p6.lon! - p5.lon!) * 3) / 4);
    const added = points.filter((p) => p.added);
    expect(added).toHaveLength(2);

    const fixed = writeFit(original, parsed, points);
    expect(verifyFit(original, fixed, parsed, 2)).toEqual([]);

    const before = decode(original);
    const after = decode(fixed);
    expect(after.recordMesgs).toHaveLength(before.recordMesgs.length + 2);

    // The new samples sit between 5 s and 14 s, in time order, with no sensor data.
    const times = after.recordMesgs.map((r) => (r.timestamp as Date).getTime());
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    const news = [after.recordMesgs[6], after.recordMesgs[7]];
    expect(news.map((r) => (r.timestamp as Date).getTime())).toEqual(added.map((p) => p.time));
    for (const r of news) {
      expect(r.heartRate).toBeUndefined();
      expect(r.cadence).toBeUndefined();
      expect(r.power).toBeUndefined();
      expect(r.altitude).toBeUndefined();
      expect(r.positionLat).toBe(toSemi(north));
      expect(r.distance as number).toBeGreaterThan(25);
    }

    // Every recorded sample keeps its time, heart rate, cadence, power and altitude.
    const sensors = (r: Record<string, unknown>) => [r.timestamp, r.heartRate, r.cadence, r.power, r.altitude];
    const kept = after.recordMesgs.filter((_, i) => i !== 6 && i !== 7);
    expect(kept.map(sensors)).toEqual(before.recordMesgs.map(sensors));

    // The detour (45 m east became ~117 m) makes the ride longer; distance never goes backwards.
    const detour = metresBetween(p5.lat!, p5.lon!, points[6].lat!, points[6].lon!) +
      metresBetween(points[6].lat!, points[6].lon!, points[7].lat!, points[7].lon!) +
      metresBetween(points[7].lat!, points[7].lon!, p6.lat!, p6.lon!);
    const dist = after.recordMesgs.map((r) => r.distance as number);
    for (let i = 1; i < dist.length; i++) expect(dist[i]).toBeGreaterThanOrEqual(dist[i - 1]);
    expect(after.sessionMesgs[0].totalDistance as number).toBeCloseTo(95 - 45 + detour, 0);
    expect(after.sessionMesgs[0].totalElapsedTime).toBe(before.sessionMesgs[0].totalElapsedTime);
    expect(reportedDistance(fixed, parseFit(fixed))!).toBeCloseTo(after.sessionMesgs[0].totalDistance as number, 1);

    // Reading the fixed file back gives the edited track.
    const reparsed = parseFit(fixed);
    expect(reparsed.points).toHaveLength(points.length);
    expect(reparsed.points[6].lat).toBeCloseTo(north, 6);
  });

  it("puts our local message definition back for messages that follow", () => {
    // Hand-built file whose records use local message 15.
    const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
    const def = [0x4f, 0, 0, 20, 0, 4, 253, 4, 0x86, 0, 4, 0x85, 1, 4, 0x85, 3, 1, 0x02]; // + heart rate
    const rec = (t: number, lon: number, hr: number) => [0x0f, ...le32(t), ...le32(toSemi(52)), ...le32(toSemi(lon)), hr];
    const data = [...def, ...rec(1000, 4, 120), ...rec(1010, 4.001, 130), ...rec(1011, 4.002, 131)];
    const header = [14, 0x20, 0, 0, ...le32(data.length), 0x2e, 0x46, 0x49, 0x54, 0, 0];
    const original = new Uint8Array([...header, ...data, 0, 0]);
    const parsed = parseFit(original);
    const points = insertPoint(parsed.points, 0, 52.0001, 4.0005);
    const fixed = writeFit(original, parsed, points);
    expect(verifyFit(original, fixed, parsed, 1)).toEqual([]);
    const after = decode(fixed);
    expect(after.recordMesgs.map((r) => r.heartRate)).toEqual([120, undefined, 130, 131]);
  });

  it("refuses a file where a recorded value was changed", () => {
    const original = makeFit();
    const parsed = parseFit(original);
    const points = insertPoint(parsed.points, 5, 52.3702, parsed.points[5].lon! + 0.0002);
    const fixed = writeFit(original, parsed, points);
    // Tamper: change a heart rate after the fact.
    const tampered = new Uint8Array(fixed);
    const at = tampered.findIndex((_, i) => i > 20 && tampered[i] === 120 && tampered[i - 1] !== 0);
    tampered[at] = 99;
    expect(verifyFit(original, tampered, parsed, 1).length).toBeGreaterThan(0);
    // Saying a different number of points were added is also caught.
    expect(verifyFit(original, fixed, parsed, 2).length).toBeGreaterThan(0);
  });
});

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <trk><name>Morning Ride</name><trkseg>
  <trkpt lat="52.3700000" lon="4.8900000"><ele>1.2</ele><time>2026-10-01T08:00:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
  <trkpt lat="52.3700000" lon="4.8930000"><ele>1.4</ele><time>2026-10-01T08:00:09Z</time></trkpt>
  <trkpt lat="52.3700000" lon="4.8940000"><time>2026-10-01T08:00:12Z</time></trkpt>
 </trkseg></trk>
</gpx>`;

describe("GPX with added points", () => {
  it("adds a minimal track point with a time by distance", () => {
    const parsed = parseGpx(GPX);
    const points = insertPoint(parsed.points, 0, 52.37, 4.891);
    expect(points[1].time).toBe(Date.parse("2026-10-01T08:00:03Z"));
    const fixed = writeGpx(GPX, parsed, points);
    expect(verifyGpx(GPX, fixed, parsed, points)).toEqual([]);
    expect(fixed).toContain(
      '</trkpt>\n  <trkpt lat="52.37" lon="4.891"><time>2026-10-01T08:00:03Z</time></trkpt>\n  <trkpt lat="52.3700000" lon="4.8930000">',
    );
    const reparsed = parseGpx(fixed);
    expect(reparsed.points).toHaveLength(4);
    expect(reparsed.points[1].time).toBe(points[1].time);
  });

  it("refuses other changes", () => {
    const parsed = parseGpx(GPX);
    const points = insertPoint(parsed.points, 0, 52.37, 4.891);
    const fixed = writeGpx(GPX, parsed, points);
    expect(verifyGpx(GPX, fixed.replace("<ele>1.4", "<ele>9.9"), parsed, points).length).toBe(1);
    const withHr = fixed.replace("<time>2026-10-01T08:00:03Z</time></trkpt>", "<time>2026-10-01T08:00:03Z</time><extensions>hr</extensions></trkpt>");
    expect(verifyGpx(GPX, withHr, parsed, points).length).toBe(1);
  });
});
