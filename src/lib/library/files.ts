/**
 * Turning a chosen folder into a list of files, opening .zip files inside it
 * (e.g. a Google Takeout archive) as if they were folders, and unpacking .gz.
 */

import { readZip } from "../zip";
import { isStravaExport } from "./strava";

export interface LibraryFile {
  /** Path from the chosen folder, e.g. "Exports/TomTom/run.fit". Files inside a zip continue its path. */
  path: string;
  name: string;
  size: number;
  read(): Promise<Uint8Array>;
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export async function gunzipIfNeeded(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzip(bytes)) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Files to skip entirely: system clutter. */
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX\/.*|\._[^/]*)$/i;

export interface FolderScan {
  files: LibraryFile[];
  /** Zips in the folder that are Strava exports (not indexed as activities). */
  stravaExports: { path: string; file: File }[];
}

/** Lists the files of a folder picked with <input webkitdirectory>, opening zips inside it. */
export async function scanFolder(list: File[]): Promise<FolderScan> {
  const files: LibraryFile[] = [];
  const stravaExports: FolderScan["stravaExports"] = [];
  for (const f of list) {
    const path = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (JUNK.test(path)) continue;
    if (/\.zip$/i.test(f.name)) {
      try {
        const entries = await readZip(f);
        if (isStravaExport(entries)) {
          stravaExports.push({ path, file: f });
          continue;
        }
        for (const e of entries) {
          if (e.dir || JUNK.test(e.name)) continue;
          files.push({ path: `${path}/${e.name}`, name: e.name.split("/").pop()!, size: e.size, read: e.read });
        }
        continue;
      } catch {
        // Not a readable zip: list it like any other file.
      }
    }
    files.push({ path, name: f.name, size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()) });
  }
  return { files, stravaExports };
}
