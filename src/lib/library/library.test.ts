import { describe, expect, it } from "vitest";
import { readZip, writeZip } from "../zip";
import { readActivities, sportFromName, type Activity } from "./formats";
import { compare, findMatches, previewOf } from "./match";
import { parseStravaDate, readActivitiesCsv, openStravaExport } from "./strava";
import { buildStravaFit, exportFileName } from "./export";
import { guessSport, sportFromStrava } from "./sports";

const T0 = Date.UTC(2020, 4, 3, 7, 12, 0);
const iso = (t: number) => new Date(t).toISOString();
const enc = (s: string) => new TextEncoder().encode(s);

/** A straight run north, one point a second, ~3 m apart. */
function points(n: number, lat0 = 52.0, lon0 = 4.0, t0 = T0) {
  return Array.from({ length: n }, (_, i) => ({ time: t0 + i * 1000, lat: lat0 + i * 0.000027, lon: lon0 }));
}

function gpx(n: number, opts: { hr?: boolean; type?: string; t0?: number; lon0?: number } = {}) {
  const pts = points(n, 52.0, opts.lon0 ?? 4.0, opts.t0 ?? T0)
    .map(
      (p, i) =>
        `<trkpt lat="${p.lat}" lon="${p.lon}"><ele>${10 + i}</ele><time>${iso(p.time)}</time>${opts.hr ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${120 + (i % 10)}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>` : ""}</trkpt>`,
    )
    .join("\n");
  return `<?xml version="1.0"?><gpx version="1.1" creator="TomTom MySports"><trk><name>Morning &amp; run</name>${opts.type ? `<type>${opts.type}</type>` : ""}<trkseg>${pts}</trkseg></trk></gpx>`;
}

describe("reading files", () => {
  it("reads GPX with heart rate", () => {
    const [a] = readActivities("run.gpx", enc(gpx(600, { hr: true, type: "running" })));
    expect(a.format).toBe("gpx");
    expect(a.sport).toBe("run");
    expect(a.title).toBe("Morning & run");
    expect(a.device).toBe("TomTom MySports");
    expect(a.channels).toEqual(["gps", "elevation", "heartRate"]);
    expect(a.start).toBe(T0);
    expect(a.end).toBe(T0 + 599_000);
    expect(a.distance).toBeGreaterThan(1700);
    expect(a.distance).toBeLessThan(1900);
  });

  it("reads TCX with laps, distance and cadence", () => {
    const tps = points(5)
      .map(
        (p, i) =>
          `<Trackpoint><Time>${iso(p.time)}</Time><Position><LatitudeDegrees>${p.lat}</LatitudeDegrees><LongitudeDegrees>${p.lon}</LongitudeDegrees></Position><AltitudeMeters>5</AltitudeMeters><DistanceMeters>${i * 3}</DistanceMeters><HeartRateBpm><Value>130</Value></HeartRateBpm><Cadence>85</Cadence></Trackpoint>`,
      )
      .join("");
    const tcx = `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity Sport="Biking"><Id>${iso(T0)}</Id><Lap StartTime="${iso(T0)}"><TotalTimeSeconds>4</TotalTimeSeconds><DistanceMeters>12.5</DistanceMeters><Track>${tps}</Track></Lap><Creator><Name>TomTom GPS Watch</Name></Creator></Activity></Activities></TrainingCenterDatabase>`;
    const [a] = readActivities("ride.tcx", enc(tcx));
    expect(a.format).toBe("tcx");
    expect(a.sport).toBe("ride");
    expect(a.device).toBe("TomTom GPS Watch");
    expect(a.distance).toBe(12.5);
    expect(a.samples[4]).toMatchObject({ distance: 12, heartRate: 130, cadence: 85, elevation: 5 });
    expect(a.channels).toEqual(["gps", "elevation", "heartRate", "cadence"]);
  });

  it("reads Nike Run Club JSON", () => {
    const pts = points(4);
    const nike = {
      id: "abc",
      type: "run",
      start_epoch_ms: T0,
      end_epoch_ms: T0 + 3000,
      tags: { "com.nike.name": "Thursday Run" },
      summaries: [{ metric: "distance", summary: "total", value: 0.01 }],
      metrics: [
        { type: "latitude", unit: "DEG", values: pts.map((p) => ({ start_epoch_ms: p.time, end_epoch_ms: p.time, value: p.lat })) },
        { type: "longitude", unit: "DEG", values: pts.map((p) => ({ start_epoch_ms: p.time, end_epoch_ms: p.time, value: p.lon })) },
        { type: "heart_rate", unit: "BPM", values: [{ start_epoch_ms: T0 + 1000, end_epoch_ms: T0 + 1000, value: 140 }] },
        { type: "distance", unit: "KM", values: [{ start_epoch_ms: T0, end_epoch_ms: T0 + 3000, value: 0.01 }] },
      ],
    };
    const [a] = readActivities("nike.json", enc(JSON.stringify({ activities: [nike] })));
    expect(a.format).toBe("nike");
    expect(a.sport).toBe("run");
    expect(a.title).toBe("Thursday Run");
    expect(a.distance).toBe(10);
    expect(a.channels).toEqual(["gps", "heartRate"]);
    expect(a.samples.find((s) => s.time === T0 + 3000)?.distance).toBe(10);
  });

  it("reads a Google Fit session as a summary without samples", () => {
    const s = {
      fitnessActivity: "walking",
      startTime: iso(T0),
      endTime: iso(T0 + 1800_000),
      duration: "1800s",
      aggregate: [{ metricName: "com.google.distance.delta", floatValue: 2400.5 }],
    };
    const [a] = readActivities("2020-05-03T09_12_00+02_00_WALKING.json", enc(JSON.stringify(s)));
    expect(a).toMatchObject({ format: "googlefit", sport: "walk", start: T0, end: T0 + 1800_000, distance: 2400.5, channels: [] });
  });

  it("says when a JSON file isn't an activity", () => {
    expect(() => readActivities("daily.json", enc('{"Data Points": []}'))).toThrow(/isn't an activity/);
  });

  it("guesses sports from names", () => {
    expect(sportFromName("2019-03-30T09_15_32+01_00_RUNNING.tcx")).toBe("run");
    expect(guessSport("biking.mountain")).toBe("mtb");
    expect(guessSport("cycling", "gravelCycling")).toBe("gravel");
    expect(guessSport("Other")).toBeNull();
    expect(sportFromStrava("E-Bike Ride")).toBe("ebike");
    expect(sportFromStrava("Run")).toBe("run");
  });
});

describe("zip", () => {
  it("writes and reads back", async () => {
    const z = writeZip([
      { name: "a.txt", data: enc("hello") },
      { name: "dir/b.gpx", data: enc("world") },
    ]);
    const entries = await readZip(new Blob([z as BlobPart]));
    expect(entries.map((e) => e.name)).toEqual(["a.txt", "dir/b.gpx"]);
    expect(new TextDecoder().decode(await entries[1].read())).toBe("world");
  });
});

describe("Strava export", () => {
  it("parses Strava's dates (UTC)", () => {
    expect(parseStravaDate("May 3, 2020, 7:12:00 AM")).toBe(T0);
    expect(parseStravaDate("May 3, 2020, 7:12:00 PM")).toBe(T0 + 12 * 3600_000);
    expect(parseStravaDate("3 May 2020, 07:12:00")).toBe(T0);
  });

  it("reads activities.csv and the activity files", async () => {
    const csv = [
      "Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,Distance,Max Heart Rate,Relative Effort,Commute,Activity Private Note,Activity Gear,Filename,Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance",
      `123,"May 3, 2020, 7:12:00 AM",Morning Run,Run,"A ""nice"", run",600,1.80,,,false,,,activities/123.gpx,,,600,590,1801.5`,
      `124,"May 4, 2020, 7:12:00 AM",Manual,Walk,,3600,4.00,,,false,,,,,,3600,3600,4000.0`,
    ].join("\n");
    expect(readActivitiesCsv(csv)[0]).toMatchObject({ id: "123", type: "Run", sport: "run", start: T0, distance: 1801.5, file: "activities/123.gpx" });
    const zip = writeZip([
      { name: "export_1/activities.csv", data: enc(csv) },
      { name: "export_1/activities/123.gpx", data: enc(gpx(600, { hr: true, t0: T0 + 2000 })) },
    ]);
    const ex = await openStravaExport(new Blob([zip as BlobPart]));
    await ex.readFiles(() => {});
    const [run, manual] = ex.activities;
    expect(run.exactTimes).toBe(true);
    expect(run.start).toBe(T0 + 2000);
    expect(run.channels).toContain("heartRate");
    expect(run.preview?.gpsCount).toBe(600);
    expect(manual.file).toBeNull();
    expect(manual.preview).toBeNull();
  });
});

describe("matching", () => {
  const act = (text: string): Activity => readActivities("x.gpx", enc(text))[0];
  const comparable = (a: Activity) => ({ ...a, preview: previewOf(a.samples) });

  it("finds the same activity as exact", () => {
    const a = comparable(act(gpx(600)));
    const b = comparable(act(gpx(600, { hr: true, t0: T0 + 1000 })));
    const m = compare(a, b)!;
    expect(m.kind).toBe("exact");
    expect(m.onlyOther).toEqual(["heartRate"]);
  });

  it("calls a longer recording of the same run partial", () => {
    const a = comparable(act(gpx(300)));
    const b = comparable(act(gpx(900)));
    expect(compare(a, b)?.kind).toBe("partial");
  });

  it("calls it partial when only one side has GPS", () => {
    const a = comparable(act(gpx(600)));
    const manual = { start: T0, end: T0 + 599_000, distance: a.distance, channels: null, preview: null };
    expect(compare(a, manual)?.kind).toBe("partial");
  });

  it("ignores activities at the same time far apart, or at other times", () => {
    const a = comparable(act(gpx(600)));
    expect(compare(a, comparable(act(gpx(600, { lon0: 5.0 }))))).toBeNull();
    expect(compare(a, comparable(act(gpx(600, { t0: T0 + 3600_000 }))))).toBeNull();
  });

  it("finds matches among many", () => {
    const a = comparable(act(gpx(600)));
    const others = [0, 1, 2, 3].map((d) => comparable(act(gpx(600, { t0: T0 + d * 86400_000 }))));
    const found = findMatches([a], others).get(a)!;
    expect(found).toHaveLength(1);
    expect(found[0].other).toBe(others[0]);
  });
});

describe("export for Strava", () => {
  it("writes a FIT with the sport and every recorded value", () => {
    const a = readActivities("run.gpx", enc(gpx(120, { hr: true })))[0];
    const fit = buildStravaFit(a, "trailrun");
    const [back] = readActivities("out.fit", fit);
    expect(back.sport).toBe("trailrun");
    expect(back.rawSport).toBe("running / trail");
    expect(back.samples).toHaveLength(120);
    expect(back.samples[5].heartRate).toBe(a.samples[5].heartRate);
    expect(back.samples[5].lat).toBeCloseTo(a.samples[5].lat!, 6);
    expect(back.start).toBe(a.start);
    expect(back.distance).toBeCloseTo(a.distance!, 0);
  });

  it("writes a summary-only activity with its times and distance", () => {
    const a: Activity = { format: "googlefit", sport: "walk", rawSport: "walking", title: null, device: null, start: T0, end: T0 + 1800_000, distance: 2400, samples: [], channels: [] };
    const [back] = readActivities("out.fit", buildStravaFit(a, "walk"));
    expect(back).toMatchObject({ sport: "walk", start: T0, end: T0 + 1800_000 });
    expect(back.distance).toBeCloseTo(2400, 0);
  });

  it("names files by date, sport and title", () => {
    const a = readActivities("run.gpx", enc(gpx(10)))[0];
    const used = new Set<string>();
    const first = exportFileName(a, "run", used);
    expect(first).toMatch(/^2020-05-03_\d{4}_Run_Morning-run\.fit$/);
    expect(exportFileName(a, "run", used)).toMatch(/_2\.fit$/);
  });
});
