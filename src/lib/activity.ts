import { isFit, parseFit, reportedDistance, verifyFit, writeFit } from "./fit";
import { isGpx, parseGpx, verifyGpx, writeGpx } from "./gpx";
import { trackLength, type TrackPoint } from "./track";

export interface LoadedActivity {
  kind: "fit" | "gpx";
  fileName: string;
  points: TrackPoint[];
  /** Builds the fixed file and checks nothing but positions (and distance/speed) changed. */
  build(points: TrackPoint[]): { data: Uint8Array; problems: string[] };
  /** Total distance in metres for these points, as the fixed file would report it. */
  distance(points: TrackPoint[]): number | null;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Turns "activity.fit.gz" into "activity-fixed.fit". */
export function fixedFileName(name: string, kind: "fit" | "gpx"): string {
  const base = name.replace(/\.gz$/i, "").replace(/\.(fit|gpx)$/i, "");
  return `${base}-fixed.${kind}`;
}

export function loadActivityBytes(fileName: string, raw: Uint8Array): Promise<LoadedActivity> | LoadedActivity {
  if (isGzip(raw)) {
    return gunzip(raw).then((bytes) => loadActivityBytes(fileName, bytes));
  }
  if (isFit(raw)) {
    const parsed = parseFit(raw);
    return {
      kind: "fit",
      fileName,
      points: parsed.points,
      build(points) {
        const data = writeFit(raw, parsed, points);
        return { data, problems: verifyFit(raw, data, parsed) };
      },
      distance(points) {
        // Falls back to the GPS track length if the file stores no distance.
        return reportedDistance(writeFit(raw, parsed, points), parsed) ?? trackLength(points);
      },
    };
  }
  const text = new TextDecoder().decode(raw);
  if (isGpx(text)) {
    const parsed = parseGpx(text);
    return {
      kind: "gpx",
      fileName,
      points: parsed.points,
      build(points) {
        const fixed = writeGpx(text, parsed, points);
        return { data: new TextEncoder().encode(fixed), problems: verifyGpx(text, fixed, parsed) };
      },
      // GPX files don't store distance; Strava measures it from the track.
      distance: trackLength,
    };
  }
  throw new Error("Please choose a .fit or .gpx file (or a .gz of one).");
}

export async function loadActivity(file: File): Promise<LoadedActivity> {
  return loadActivityBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}
