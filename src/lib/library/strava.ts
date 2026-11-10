/**
 * Reads a Strava "Download your data" export (.zip): the list of activities
 * in activities.csv, plus each activity's original file in activities/.
 */

import { readZip, type ZipEntry } from "../zip";
import { gunzipIfNeeded } from "./files";
import { readActivities } from "./formats";
import { sportFromStrava } from "./sports";
import { previewOf, type Preview } from "./match";
import type { Channel } from "../sources";

export interface StravaActivity {
  id: string;
  name: string;
  /** Strava's sport name, e.g. "Run". */
  type: string;
  sport: string | null;
  start: number;
  end: number;
  /** Metres, or null. */
  distance: number | null;
  /** Path of its original file inside the zip, or null for manual entries. */
  file: string | null;
  /** Filled in once its file has been read. */
  channels: Channel[] | null;
  preview: Preview | null;
  /** True once start/end come from the file itself rather than the CSV. */
  exactTimes: boolean;
}

/** Splits CSV text into rows of fields (handles quotes, commas and line breaks in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim()));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Strava writes dates like "Jun 14, 2015, 7:19:27 AM" (in UTC). Also accepts
 * "14 Jun 2015, 07:19:27" and ISO dates. Returns ms since 1970, or NaN.
 */
export function parseStravaDate(s: string): number {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : t.replace(" ", "T") + "Z");
  const month = MONTHS.findIndex((m) => new RegExp(`\\b${m}`, "i").test(t));
  const year = /\b(\d{4})\b/.exec(t)?.[1];
  const time = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/.exec(t);
  const day = /\b(\d{1,2})\b/.exec(t.replace(/\d{1,2}:\d{2}(:\d{2})?/, ""))?.[1];
  if (month < 0 || !year || !time || !day) return NaN;
  let h = Number(time[1]);
  const ampm = time[4]?.toLowerCase();
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return Date.UTC(Number(year), month, Number(day), h, Number(time[2]), Number(time[3] ?? 0));
}

/** Reads activities.csv into activities (without their files yet). */
export function readActivitiesCsv(text: string): StravaActivity[] {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  if (rows.length < 1) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const first = (name: string) => header.indexOf(name);
  const last = (name: string) => header.lastIndexOf(name);
  const col = {
    id: first("activity id"),
    date: first("activity date"),
    name: first("activity name"),
    type: first("activity type"),
    elapsed: first("elapsed time"),
    // The first "Distance" is in km (or miles); a later one, if present, is in metres.
    distKm: first("distance"),
    distM: last("distance") !== first("distance") ? last("distance") : -1,
    file: first("filename"),
  };
  if (col.id < 0 || col.date < 0) throw new Error("activities.csv doesn't have the columns Strava normally writes.");
  const out: StravaActivity[] = [];
  for (const r of rows.slice(1)) {
    const start = parseStravaDate(r[col.date] ?? "");
    if (!Number.isFinite(start)) continue;
    const elapsed = Number(r[col.elapsed]) || 0;
    const m = col.distM >= 0 ? Number(r[col.distM]) : NaN;
    const km = Number((r[col.distKm] ?? "").replace(",", ""));
    const distance = Number.isFinite(m) && m > 0 ? m : Number.isFinite(km) && km > 0 ? km * 1000 : null;
    const type = (r[col.type] ?? "").trim();
    out.push({
      id: (r[col.id] ?? "").trim(),
      name: (r[col.name] ?? "").trim(),
      type,
      sport: sportFromStrava(type),
      start,
      end: start + elapsed * 1000,
      distance,
      file: col.file >= 0 && r[col.file]?.trim() ? r[col.file].trim() : null,
      channels: null,
      preview: null,
      exactTimes: false,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface StravaExport {
  activities: StravaActivity[];
  /** Reads every activity's file to get exact times, sensors and tracks. */
  readFiles(onProgress: (done: number, total: number) => void, signal?: { cancelled: boolean }): Promise<void>;
}

/** True if this zip's entries look like a Strava export. */
export function isStravaExport(entries: ZipEntry[]): boolean {
  return entries.some((e) => /(^|\/)activities\.csv$/i.test(e.name));
}

export async function openStravaExport(blob: Blob): Promise<StravaExport> {
  const entries = await readZip(blob);
  const csv = entries.find((e) => /(^|\/)activities\.csv$/i.test(e.name));
  if (!csv) throw new Error("This zip has no activities.csv, so it doesn't look like a Strava export. On strava.com: Settings → My Account → Download or Delete Your Account → Request your archive.");
  const prefix = csv.name.slice(0, csv.name.length - "activities.csv".length);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const activities = readActivitiesCsv(new TextDecoder().decode(await csv.read()));
  return {
    activities,
    async readFiles(onProgress, signal) {
      const todo = activities.filter((a) => a.file && byName.has(prefix + a.file));
      let done = 0;
      const worker = async () => {
        while (todo.length && !signal?.cancelled) {
          const a = todo.shift()!;
          try {
            const entry = byName.get(prefix + a.file!)!;
            const bytes = await gunzipIfNeeded(await entry.read());
            const [act] = readActivities(entry.name.replace(/\.gz$/i, ""), bytes);
            if (act) {
              if (act.samples.length) {
                a.start = act.start;
                a.end = act.end;
                a.exactTimes = true;
              }
              a.channels = act.channels;
              a.preview = previewOf(act.samples);
            }
          } catch {
            // Keep the CSV's details if the file can't be read.
          }
          done++;
          if (done % 10 === 0) onProgress(done, done + todo.length);
          // Let the page redraw now and then.
          if (done % 5 === 0) await new Promise((r) => setTimeout(r, 0));
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      activities.sort((x, y) => x.start - y.start);
      onProgress(done, done);
    },
  };
}
