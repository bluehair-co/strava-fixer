import { describe, expect, it } from "vitest";
import { Encoder, Profile } from "@garmin/fitsdk";
import { buildCombined, defaultChoices, planCombine, verifyCombined, type Choices } from "./combine";
import { readSource, type Source } from "./sources";
import { loadActivityBytes } from "./activity";
import { movePoint } from "./track";

const toSemi = (deg: number) => Math.round((deg * 2 ** 31) / 180);
const START = new Date("2026-10-01T08:00:00Z").getTime();
const LAT0 = 52.37;
const LON_STEP = 5 / (111320 * Math.cos((LAT0 * Math.PI) / 180)); // 5 m east
const lonAt = (s: number) => 4.89 + s * LON_STEP;

/** A FIT recording from `from` to `to` seconds after START with the given fields per second. */
function fit(from: number, to: number, fields: (s: number) => Record<string, unknown>, sport = "cycling"): Uint8Array {
  const encoder = new Encoder();
  const write = (num: number, mesg: object) => encoder.onMesg(num, mesg as Parameters<Encoder["onMesg"]>[1]);
  write(Profile.MesgNum.FILE_ID, { type: "activity", manufacturer: "development", product: 1, timeCreated: new Date(START + from * 1000) });
  for (let s = from; s < to; s++) write(Profile.MesgNum.RECORD, { timestamp: new Date(START + s * 1000), ...fields(s) });
  write(Profile.MesgNum.LAP, { timestamp: new Date(START + (to - 1) * 1000), startTime: new Date(START + from * 1000), totalElapsedTime: to - from });
  write(Profile.MesgNum.SESSION, { timestamp: new Date(START + (to - 1) * 1000), startTime: new Date(START + from * 1000), totalElapsedTime: to - from, sport });
  return encoder.close();
}

const gps = (s: number) => ({ positionLat: toSemi(LAT0), positionLong: toSemi(lonAt(s)) });
/** Watch without GPS: heart rate, power, elevation. */
const watch = () => fit(0, 60, (s) => ({ heartRate: 120 + (s % 9), power: 200 + s, altitude: 10 + s * 0.2 }));
/** Phone: GPS and cadence (from a sensor). */
const phone = () => fit(0, 60, (s) => ({ ...gps(s), cadence: 80 + (s % 5) }));

const load = (...files: [string, Uint8Array][]) => files.map(([n, b]) => readSource(n, b));

function combined(sources: Source[], choices: Choices) {
  const plan = planCombine(sources, choices);
  return { plan, result: buildCombined(sources, choices, plan) };
}

describe("reading files", () => {
  it("reads every kind of data from a GPX file", () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1" xmlns:gpxtpx="x"><trk><name>Morning Ride</name><type>Biking</type><trkseg>
      <trkpt lat="52.37" lon="4.89"><ele>3.5</ele><time>2026-10-01T08:00:00Z</time><extensions><power>210</power>
      <gpxtpx:TrackPointExtension><gpxtpx:atemp>18</gpxtpx:atemp><gpxtpx:hr>102.87</gpxtpx:hr><gpxtpx:cad>85</gpxtpx:cad></gpxtpx:TrackPointExtension></extensions></trkpt>
    </trkseg></trk></gpx>`;
    const src = readSource("ride.gpx", new TextEncoder().encode(gpx));
    expect(src.samples[0]).toEqual({ time: START, lat: 52.37, lon: 4.89, elevation: 3.5, heartRate: 102.87, cadence: 85, power: 210, temperature: 18 });
    expect(src.title).toBe("Morning Ride");
    expect(src.sport).toBe("cycling");
    expect(src.channels).toEqual(["gps", "elevation", "heartRate", "cadence", "power", "temperature"]);
  });

  it("reads a FIT file", () => {
    const src = readSource("w.fit", watch());
    expect(src.channels).toEqual(["elevation", "heartRate", "power"]);
    expect(src.samples).toHaveLength(60);
    expect(src.samples[5].heartRate).toBe(125);
  });
});

describe("combining files", () => {
  it("starts with GPS from the file with a track and the rest from the first file that has it", () => {
    const sources = load(["watch.fit", watch()], ["phone.fit", phone()]);
    const choices = defaultChoices(sources);
    expect(choices.pick).toEqual({ gps: 1, elevation: 0, heartRate: 0, cadence: 1, power: 0 });
  });

  it("copies one file exactly when only the GPS comes from another", () => {
    const sources = load(["watch.fit", watch()], ["phone.fit", phone()]);
    const { plan, result } = combined(sources, { pick: { gps: 1, heartRate: 0, power: 0, elevation: 0, cadence: null }, fill: false, sport: null });
    expect(plan.how).toBe("exact");
    expect(plan.base).toBe(0);
    expect(result.problems).toEqual([]);
    const out = readSource("out.fit", result.data);
    expect(out.samples[30].lon).toBeCloseTo(lonAt(30), 6);
    expect(out.samples.map((s) => s.heartRate)).toEqual(sources[0].samples.map((s) => s.heartRate));
    expect(out.channels).not.toContain("cadence");
  });

  it("builds a new file when data comes from several files", () => {
    const sources = load(["watch.fit", watch()], ["phone.fit", phone()]);
    const { plan, result } = combined(sources, defaultChoices(sources));
    expect(plan.how).toBe("rebuild");
    expect(result.kind).toBe("fit");
    expect(result.problems).toEqual([]);
    const out = readSource("out.fit", result.data);
    expect(out.samples).toHaveLength(60);
    expect(out.samples.map((s) => s.heartRate)).toEqual(sources[0].samples.map((s) => s.heartRate));
    expect(out.samples.map((s) => s.power)).toEqual(sources[0].samples.map((s) => s.power));
    expect(out.samples.map((s) => s.elevation)).toEqual(sources[0].samples.map((s) => s.elevation));
    expect(out.samples.map((s) => s.cadence)).toEqual(sources[1].samples.map((s) => s.cadence));
    expect(out.samples[30].lon).toBeCloseTo(lonAt(30), 6);
    expect(out.sport).toBe("cycling");
  });

  it("leaves out data you turned off", () => {
    const sources = load(["watch.fit", watch()], ["phone.fit", phone()]);
    const choices = defaultChoices(sources);
    choices.pick.power = null;
    const { result } = combined(sources, choices);
    expect(result.problems).toEqual([]);
    expect(readSource("out.fit", result.data).channels).not.toContain("power");
  });

  it("writes GPX when values come from a GPX file, keeping decimals", () => {
    const pts = Array.from({ length: 30 }, (_, s) =>
      `<trkpt lat="${LAT0}" lon="${lonAt(s)}"><time>${new Date(START + s * 1000).toISOString()}</time><extensions><hr>${100 + s + 0.25}</hr></extensions></trkpt>`,
    ).join("");
    const gpx = new TextEncoder().encode(`<gpx version="1.1"><trk><name>Commute</name><trkseg>${pts}</trkseg></trk></gpx>`);
    const sources = load(["hr.gpx", gpx], ["phone.fit", phone()]);
    const { plan, result } = combined(sources, { pick: { gps: 1, heartRate: 0, cadence: 1 }, fill: false, sport: null });
    expect(plan.how).toBe("rebuild");
    expect(result.kind).toBe("gpx");
    expect(result.problems).toEqual([]);
    const text = new TextDecoder().decode(result.data);
    expect(text).toContain("<gpxtpx:hr>101.25</gpxtpx:hr>");
    expect(text).toContain("<name>Commute</name>");
  });

  it("puts recordings made one after the other together", () => {
    const first = fit(0, 30, (s) => ({ ...gps(s), heartRate: 120 }));
    const second = fit(40, 70, (s) => ({ ...gps(s), heartRate: 130 }));
    const sources = load(["a.fit", first], ["b.fit", second]);
    const { plan, result } = combined(sources, defaultChoices(sources));
    expect(plan.how).toBe("join");
    expect(result.problems).toEqual([]);
    expect(readSource("out.fit", result.data).samples).toHaveLength(60);
  });

  it("catches a value that no file recorded", () => {
    const pts = Array.from({ length: 30 }, (_, s) =>
      `<trkpt lat="${LAT0}" lon="${lonAt(s)}"><time>${new Date(START + s * 1000).toISOString()}</time><extensions><hr>${100 + s + 0.25}</hr></extensions></trkpt>`,
    ).join("");
    const sources = load(["hr.gpx", new TextEncoder().encode(`<gpx version="1.1"><trk><trkseg>${pts}</trkseg></trk></gpx>`)], ["phone.fit", phone()]);
    const choices: Choices = { pick: { gps: 1, heartRate: 0 }, fill: false, sport: null };
    const { result } = combined(sources, choices);
    expect(result.problems).toEqual([]);
    const text = new TextDecoder().decode(result.data);
    const tampered = new TextEncoder().encode(text.replace("<gpxtpx:hr>101.25<", "<gpxtpx:hr>99<"));
    expect(verifyCombined(sources, choices, tampered, 60).length).toBeGreaterThan(0);
    const noHeartRate = { ...choices, pick: { ...choices.pick, heartRate: null } };
    expect(verifyCombined(sources, noHeartRate, result.data, 60)).toEqual(["The new file has heart rate, which you turned off."]);
  });
});

describe("fixing GPS in a combined file", () => {
  it("opens the combined file in the fixer and lets a point be moved, keeping every other value", async () => {
    const sources = load(["watch.fit", watch()], ["phone.fit", phone()]);
    const { result } = combined(sources, defaultChoices(sources));
    expect(result.problems).toEqual([]);
    const activity = await loadActivityBytes(result.fileName, result.data);
    expect(activity.points.length).toBeGreaterThan(0);
    const unchanged = activity.build(activity.points);
    expect(unchanged.problems).toEqual([]);
    const i = Math.floor(activity.points.length / 2);
    const p = activity.points[i];
    const moved = movePoint(activity.points, i, p.lat! + 0.0001, p.lon!);
    const fixed = activity.build(moved);
    expect(fixed.problems).toEqual([]);
    const reread = await loadActivityBytes(result.fileName, fixed.data);
    expect(reread.points[i].lat).toBeCloseTo(p.lat! + 0.0001, 6);
  });
});
