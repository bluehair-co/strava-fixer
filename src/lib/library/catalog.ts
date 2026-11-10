/**
 * The index of a folder: one entry per activity found (a file can hold
 * several), plus the files that couldn't be read or aren't activities, and
 * the folder tree to show them in.
 */

import type { Channel } from "../sources";
import { gunzipIfNeeded, type LibraryFile } from "./files";
import { ACTIVITY_EXTENSIONS, NotAnActivity, readActivities, sportFromName, type Activity, type Format } from "./formats";
import { previewOf, type Preview } from "./match";

export interface Item {
  /** Stays the same when you load the folder again (even if it moved), so marks are remembered. */
  key: string;
  path: string;
  file: LibraryFile;
  /** Which activity in the file (most files hold one). */
  index: number;
  count: number;
  kind: "activity" | "other" | "error";
  message?: string;
  format?: Format;
  /** Sport found in the file, or guessed from its name; null if unknown. */
  sport: string | null;
  rawSport?: string | null;
  title?: string | null;
  device?: string | null;
  start: number;
  end: number;
  distance: number | null;
  channels: Channel[] | null;
  samples: number;
  preview: Preview | null;
}

export function itemKey(name: string, index: number, start: number): string {
  return `${name}|${index}|${start}`;
}

/** Reads one file into its activities, as a list of items. */
export async function readItems(file: LibraryFile): Promise<Item[]> {
  const base = { path: file.path, file, index: 0, count: 1, sport: null, start: 0, end: 0, distance: null, channels: null, samples: 0, preview: null };
  if (!ACTIVITY_EXTENSIONS.test(file.name) || file.size > 200 * 1024 * 1024) {
    return [{ ...base, key: file.path, kind: "other", message: "Not an activity file." }];
  }
  try {
    const bytes = await gunzipIfNeeded(await file.read());
    const acts = readActivities(file.name.replace(/\.gz$/i, ""), bytes);
    return acts.map((a, index) => toItem(file, a, index, acts.length));
  } catch (e) {
    const kind = e instanceof NotAnActivity ? "other" : "error";
    return [{ ...base, key: file.path, kind, message: e instanceof Error ? e.message : String(e) }];
  }
}

function toItem(file: LibraryFile, a: Activity, index: number, count: number): Item {
  return {
    key: itemKey(file.name, index, a.start),
    path: file.path,
    file,
    index,
    count,
    kind: "activity",
    format: a.format,
    sport: a.sport ?? sportFromName(file.path),
    rawSport: a.rawSport,
    title: a.title,
    device: a.device,
    start: a.start,
    end: a.end,
    distance: a.distance,
    channels: a.channels,
    samples: a.samples.length,
    preview: previewOf(a.samples),
  };
}

/** Reads an item's full activity again (for the map and for exporting). */
export async function loadActivity(item: Item): Promise<Activity> {
  const bytes = await gunzipIfNeeded(await item.file.read());
  const a = readActivities(item.file.name.replace(/\.gz$/i, ""), bytes)[item.index];
  if (!a) throw new Error(`${item.path}: activity not found.`);
  return a;
}

/* ---------- Folder tree ---------- */

export interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  items: Item[];
}

export function buildTree(items: Item[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], items: [] };
  const index = new Map<string, Folder>([["", root]]);
  for (const item of items) {
    const parts = item.path.split("/");
    parts.pop();
    let parent = root;
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let f = index.get(path);
      if (!f) {
        f = { name: part, path, folders: [], items: [] };
        index.set(path, f);
        parent.folders.push(f);
      }
      parent = f;
    }
    parent.items.push(item);
  }
  const sort = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    f.items.sort((a, b) => (a.kind === "activity" ? 0 : 1) - (b.kind === "activity" ? 0 : 1) || a.start - b.start || a.path.localeCompare(b.path));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** Every item in a folder and its subfolders. */
export function allItems(f: Folder): Item[] {
  return [...f.items, ...f.folders.flatMap(allItems)];
}
