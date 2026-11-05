import { cropFile, inCrop, isCropped, NO_CROP, type Crop } from "./crop";
import { isFit, parseFit, reportedDistance, verifyFit, writeFit } from "./fit";
import { isGpx, parseGpx, verifyGpx, writeGpx } from "./gpx";
import { trackLength, type TrackPoint } from "./track";

export interface LoadedActivity {
  kind: "fit" | "gpx";
  fileName: string;
  points: TrackPoint[];
  /**
   * Builds the fixed file and checks nothing but positions (and distance/speed)
   * changed, and that added points became new samples with only a time and a position.
   * With a crop, the fixed file is then cropped and checked again (see `cropFile`).
   */
  build(points: TrackPoint[], crop?: Crop): { data: Uint8Array; problems: string[] };
  /** Total distance in metres for these points, as the fixed (and cropped) file would report it. */
  distance(points: TrackPoint[], crop?: Crop): number | null;
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

/** The file's bytes, unzipped if it was a .gz. */
export async function readActivityFile(file: File): Promise<Uint8Array> {
  const raw = new Uint8Array(await file.arrayBuffer());
  return isGzip(raw) ? gunzip(raw) : raw;
}

/** Crops a built file, if asked to and it passed its own safety check. */
function withCrop(built: { data: Uint8Array; problems: string[] }, crop: Crop) {
  if (!isCropped(crop) || built.problems.length) return built;
  return cropFile(built.data, crop);
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
      build(points, crop = NO_CROP) {
        const data = writeFit(raw, parsed, points);
        const added = points.filter((p) => p.added).length;
        return withCrop({ data, problems: verifyFit(raw, data, parsed, added) }, crop);
      },
      distance(points, crop = NO_CROP) {
        let data = writeFit(raw, parsed, points);
        if (isCropped(crop)) data = cropFile(data, crop).data;
        // Added points and cropping shift everything in the file, so read it again.
        const reported = reportedDistance(data, points.some((p) => p.added) || isCropped(crop) ? parseFit(data) : parsed);
        // Falls back to the GPS track length if the file stores no distance.
        return reported ?? trackLength(points.filter((p) => inCrop(p.time, crop)));
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
      build(points, crop = NO_CROP) {
        const fixed = writeGpx(text, parsed, points);
        return withCrop({ data: new TextEncoder().encode(fixed), problems: verifyGpx(text, fixed, parsed, points) }, crop);
      },
      // GPX files don't store distance; Strava measures it from the track.
      distance: (points, crop = NO_CROP) => trackLength(points.filter((p) => inCrop(p.time, crop))),
    };
  }
  throw new Error("Please choose a .fit or .gpx file (or a .gz of one).");
}

export async function loadActivity(file: File): Promise<LoadedActivity> {
  return loadActivityBytes(file.name, new Uint8Array(await file.arrayBuffer()));
}
