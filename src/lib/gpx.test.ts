import { describe, expect, it } from "vitest";
import { parseGpx, verifyGpx, writeGpx } from "./gpx";
import { movePoint, straighten } from "./track";

const GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx creator="StravaGPX" version="1.1" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1">
 <trk><name>Morning Ride</name><trkseg>
  <trkpt lat="52.3700000" lon="4.8900000"><ele>1.2</ele><time>2026-10-01T08:00:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>120</gpxtpx:hr><gpxtpx:cad>85</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>
  <trkpt lat='52.3701' lon='4.8901'><ele>1.4</ele><time>2026-10-01T08:00:01Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>121</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>
  <trkpt lon="4.8902" lat="52.3702"><ele>1.6</ele><time>2026-10-01T08:00:03Z</time></trkpt>
  <trkpt lat="52.3703" lon="4.8903"><time>2026-10-01T08:00:04Z</time></trkpt>
 </trkseg></trk>
</gpx>`;

describe("GPX", () => {
  it("reads positions and times", () => {
    const parsed = parseGpx(GPX);
    expect(parsed.points).toHaveLength(4);
    expect(parsed.points[2]).toEqual({ lat: 52.3702, lon: 4.8902, time: Date.parse("2026-10-01T08:00:03Z") });
  });

  it("writes an untouched file back unchanged", () => {
    const parsed = parseGpx(GPX);
    expect(writeGpx(GPX, parsed, parsed.points)).toBe(GPX);
  });

  it("changes only lat/lon when editing", () => {
    const parsed = parseGpx(GPX);
    let points = movePoint(parsed.points, 1, 52.4, 4.9);
    points = straighten(points, 0, 3);
    const fixed = writeGpx(GPX, parsed, points);
    expect(verifyGpx(GPX, fixed, parsed)).toEqual([]);
    expect(fixed).toContain("<gpxtpx:hr>121</gpxtpx:hr>");
    const reparsed = parseGpx(fixed);
    // straightened by time: point 2 is 3s into a 4s gap
    expect(reparsed.points[2].lat).toBeCloseTo(52.370225, 6);
    expect(reparsed.points[2].time).toBe(parsed.points[2].time);
  });

  it("flags other changes", () => {
    const parsed = parseGpx(GPX);
    const tampered = GPX.replace("<gpxtpx:hr>120", "<gpxtpx:hr>99");
    expect(verifyGpx(GPX, tampered, parsed).length).toBe(1);
  });
});
