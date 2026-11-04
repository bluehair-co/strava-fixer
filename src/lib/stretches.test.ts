import { describe, expect, it } from "vitest";
import { editedStretches, insertPoint, movePoint, trackLength, type TrackPoint } from "./track";

const T0 = Date.parse("2026-10-01T08:00:00Z");
const lonStep = 100 / (111320 * Math.cos((52.37 * Math.PI) / 180));

/** Ten points 100 m apart going east, 10 s apart. */
function line(): TrackPoint[] {
  return Array.from({ length: 10 }, (_, i) => ({ lat: 52.37, lon: 4.89 + i * lonStep, time: T0 + i * 10000 }));
}

describe("edited stretches", () => {
  it("is empty when nothing changed", () => {
    expect(editedStretches(line(), line())).toEqual([]);
  });

  it("measures a moved point between its unchanged neighbours", () => {
    const pts = line();
    // Pull point 3 sideways (a GPS spike) and fix it back onto the line.
    const spiky = movePoint(pts, 3, 52.371, pts[3].lon!);
    const fixed = movePoint(spiky, 3, 52.37, pts[3].lon!);
    const [s] = editedStretches(spiky, fixed);
    expect(s.from).toBe(2);
    expect(s.to).toBe(4);
    expect(s.time).toBe(T0 + 20000);
    expect(s.moved).toBe(1);
    expect(s.after).toBeCloseTo(200, 0);
    expect(s.before).toBeGreaterThan(s.after);
    // The stretches add up to the whole change in track length.
    expect(s.after - s.before).toBeCloseTo(trackLength(fixed) - trackLength(spiky), 6);
  });

  it("counts added points and keeps separate edits apart", () => {
    const pts = line();
    let edited = insertPoint(pts, 1, 52.3705, pts[1].lon! + lonStep / 2); // detour between 1 and 2
    edited = movePoint(edited, 8, 52.3702, edited[8].lon!); // recorded point 7 (index 8 after the insert)
    const stretches = editedStretches(pts, edited);
    expect(stretches).toHaveLength(2);
    expect(stretches[0]).toMatchObject({ from: 1, to: 3, added: 1, moved: 0 });
    expect(stretches[0].before).toBeCloseTo(100, 0);
    expect(stretches[0].after).toBeGreaterThan(100);
    expect(stretches[1]).toMatchObject({ from: 7, to: 9, added: 0, moved: 1 });
    const total = stretches.reduce((sum, s) => sum + s.after - s.before, 0);
    expect(total).toBeCloseTo(trackLength(edited) - trackLength(pts), 6);
  });

  it("handles an edit at the very start", () => {
    const pts = line();
    const edited = movePoint(pts, 0, 52.3701, pts[0].lon!);
    const [s] = editedStretches(pts, edited);
    expect(s).toMatchObject({ from: 0, to: 1, moved: 1 });
  });
});
