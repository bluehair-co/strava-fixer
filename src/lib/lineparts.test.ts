import { describe, expect, it } from "vitest";
import { lineParts, type TrackPoint } from "./track";

const T0 = Date.parse("2026-11-04T16:00:00Z");
const at = (s: number, lat: number | null = 52 + s / 1000): TrackPoint => ({
  lat,
  lon: lat === null ? null : 4.9,
  time: T0 + s * 1000,
});

describe("line parts", () => {
  it("draws one line when position-less samples share a time with a position (Strava app style)", () => {
    // Each second: heart rate sample, distance sample, then the position sample.
    const points = [0, 1, 2, 3, 4].flatMap((s) => [at(s, null), at(s, null), at(s)]);
    const parts = lineParts(points);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toHaveLength(5);
  });

  it("also joins when the position comes first in the second", () => {
    const points = [0, 1, 2].flatMap((s) => [at(s), at(s, null)]);
    expect(lineParts(points)).toHaveLength(1);
  });

  it("still breaks the line where the GPS had no position for a while", () => {
    const points = [at(0), at(1), at(2, null), at(3, null), at(4), at(5)];
    expect(lineParts(points)).toEqual([
      [[at(0).lat, 4.9], [at(1).lat, 4.9]],
      [[at(4).lat, 4.9], [at(5).lat, 4.9]],
    ]);
  });

  it("breaks the line at a position-less sample with no time", () => {
    const points = [at(0), { lat: null, lon: null, time: null }, at(1)];
    expect(lineParts(points)).toHaveLength(2);
  });

  it("ignores samples without a position before the first fix", () => {
    expect(lineParts([at(0, null), at(1, null), at(2), at(3)])).toHaveLength(1);
  });
});
