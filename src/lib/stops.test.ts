import { describe, expect, it } from "vitest";
import { DEFAULT_TIDY, findStops, straightenAllStops, straightenStops } from "./stops";
import { trackLength, type TrackPoint } from "./track";

const T0 = Date.parse("2026-11-09T15:00:00Z");
const LAT = 52.35;
const LON = 4.9;
const latStep = 1 / 111320; // one metre north
const lonStep = 1 / (111320 * Math.cos((LAT * Math.PI) / 180)); // one metre east

/** Repeatable "random" numbers between -1 and 1, so the GPS noise is the same every run. */
function noise(seed: number) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return (x / 2147483648) * 2 - 1;
  };
}

/**
 * A ride sampled once a second: `parts` alternate between standing still
 * (GPS wandering up to `jitter` metres) and riding east at 5 m/s.
 */
function ride(parts: { still?: number; ride?: number }[], jitter = 12): TrackPoint[] {
  const rand = noise(7);
  const pts: TrackPoint[] = [];
  let east = 0;
  let t = T0;
  for (const part of parts) {
    const seconds = part.still ?? part.ride!;
    for (let i = 0; i < seconds; i++) {
      if (part.ride) east += 5;
      const dx = part.still ? rand() * jitter : 0;
      const dy = part.still ? rand() * jitter : 0;
      pts.push({ lat: LAT + dy * latStep, lon: LON + (east + dx) * lonStep, time: t });
      t += 1000;
    }
  }
  return pts;
}

const at = (pts: TrackPoint[], i: number) => (pts[i].time! - T0) / 1000;

describe("finding stops", () => {
  it("finds a stop in the middle of a ride", () => {
    const pts = ride([{ ride: 120 }, { still: 180 }, { ride: 120 }]);
    const { stops, crop } = findStops(pts);
    expect(stops).toHaveLength(1);
    // It covers (most of) the three minutes standing still, and nothing of the riding.
    expect(at(pts, stops[0].from)).toBeGreaterThanOrEqual(112);
    expect(at(pts, stops[0].from)).toBeLessThan(130);
    expect(at(pts, stops[0].to)).toBeGreaterThan(290);
    expect(at(pts, stops[0].to)).toBeLessThanOrEqual(301);
    expect(stops[0].wander).toBeGreaterThan(500);
    expect(stops[0].straightened).toBe(false);
    expect(crop).toEqual({ start: null, end: null });
  });

  it("ignores a stop shorter than the minimum", () => {
    const pts = ride([{ ride: 120 }, { still: 40 }, { ride: 120 }]);
    expect(findStops(pts).stops).toHaveLength(0);
    expect(findStops(pts, { ...DEFAULT_TIDY, minStopSeconds: 30 }).stops).toHaveLength(1);
  });

  it("doesn't take riding for a stop", () => {
    const pts = ride([{ ride: 600 }]);
    const result = findStops(pts);
    expect(result.stops).toHaveLength(0);
    expect(result.idleStart).toBeNull();
    expect(result.idleEnd).toBeNull();
  });

  it("joins a stop that the GPS noise split in two", () => {
    // Wandering up to 25 m with a 30 m radius sometimes breaks the stop.
    const pts = ride([{ ride: 100 }, { still: 400 }, { ride: 100 }], 25);
    expect(findStops(pts).stops).toHaveLength(1);
  });

  it("straightening a stop removes the wandering and keeps everything else", () => {
    const pts = ride([{ ride: 120 }, { still: 180 }, { ride: 120 }]);
    const { stops } = findStops(pts);
    const fixed = straightenStops(pts, stops);
    expect(trackLength(fixed)).toBeLessThan(trackLength(pts) - 500);
    // Points outside the stop, and every time, are as they were.
    fixed.forEach((p, i) => {
      expect(p.time).toBe(pts[i].time);
      if (i <= stops[0].from || i >= stops[0].to) expect(p).toEqual(pts[i]);
    });
    // Once straightened, the stop is still found but marked as done.
    const again = findStops(fixed);
    expect(again.stops).toHaveLength(1);
    expect(again.stops[0].straightened).toBe(true);
  });
});

describe("idle time at the start and end", () => {
  it("crops to just before you start moving and just after you stop", () => {
    const pts = ride([{ still: 150 }, { ride: 300 }, { still: 90 }]);
    const { crop, stops, idleStart, idleEnd } = findStops(pts, { ...DEFAULT_TIDY, keepSeconds: 0 });
    expect(stops).toHaveLength(0);
    const start = (crop.start! - T0) / 1000;
    const end = (crop.end! - T0) / 1000;
    expect(start).toBeGreaterThan(140);
    expect(start).toBeLessThanOrEqual(154);
    expect(end).toBeGreaterThanOrEqual(446);
    expect(end).toBeLessThan(460);
    expect(pts[idleStart!].time).toBe(crop.start);
    expect(pts[idleEnd!].time).toBe(crop.end);
  });

  it("keeps the extra seconds asked for", () => {
    const pts = ride([{ still: 150 }, { ride: 300 }, { still: 90 }]);
    const tight = findStops(pts, { ...DEFAULT_TIDY, keepSeconds: 0 }).crop;
    const loose = findStops(pts, { ...DEFAULT_TIDY, keepSeconds: 20 }).crop;
    expect(tight.start! - loose.start!).toBe(20_000);
    expect(loose.end! - tight.end!).toBe(20_000);
  });

  it("doesn't crop when you set off straight away", () => {
    const pts = ride([{ still: 3 }, { ride: 300 }, { still: 4 }]);
    expect(findStops(pts).crop).toEqual({ start: null, end: null });
  });

  it("only looks at points with a position and a time", () => {
    const pts = ride([{ still: 150 }, { ride: 300 }]);
    // Samples without a position (like heart rate samples) between the GPS ones.
    const mixed = pts.flatMap((p) => [{ lat: null, lon: null, time: p.time }, p]);
    const a = findStops(pts).crop;
    const b = findStops(mixed).crop;
    expect(b).toEqual(a);
  });

  it("does nothing for a recording where you never moved", () => {
    const pts = ride([{ still: 300 }]);
    expect(findStops(pts)).toMatchObject({ stops: [], crop: { start: null, end: null } });
  });
});

describe("straightening all stops", () => {
  it("leaves nothing to straighten and changes only positions inside stops", () => {
    const pts = ride([{ still: 60 }, { ride: 120 }, { still: 200 }, { ride: 60 }, { still: 90 }, { ride: 120 }], 20);
    const before = findStops(pts).stops;
    expect(before.length).toBeGreaterThanOrEqual(2);
    const fixed = straightenAllStops(pts);
    expect(findStops(fixed).stops.every((s) => s.straightened)).toBe(true);
    expect(fixed.map((p) => p.time)).toEqual(pts.map((p) => p.time));
    expect(trackLength(fixed)).toBeLessThan(trackLength(pts));
  });
});
