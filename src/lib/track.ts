/** One GPS sample. lat/lon are null when the sample has no position. */
export interface TrackPoint {
  lat: number | null;
  lon: number | null;
  /** Milliseconds since 1970, or null if the file has no time for it. */
  time: number | null;
}

/**
 * Moves every point strictly between `from` and `to` onto the straight line
 * joining them. Points are spaced by their recorded time when every point has
 * one (so pauses stay pauses), otherwise evenly.
 */
export function straighten(points: TrackPoint[], from: number, to: number): TrackPoint[] {
  const [a, b] = from < to ? [from, to] : [to, from];
  const start = points[a];
  const end = points[b];
  if (start.lat === null || start.lon === null || end.lat === null || end.lon === null) {
    throw new Error("Both ends of the selection need a GPS position.");
  }
  const useTime =
    start.time !== null &&
    end.time !== null &&
    end.time > start.time &&
    points.slice(a, b + 1).every((p) => p.time !== null);

  return points.map((p, i) => {
    if (i <= a || i >= b) return p;
    const t = useTime
      ? (p.time! - start.time!) / (end.time! - start.time!)
      : (i - a) / (b - a);
    return {
      ...p,
      lat: start.lat! + (end.lat! - start.lat!) * t,
      lon: start.lon! + (end.lon! - start.lon!) * t,
    };
  });
}

/** Removes the GPS position (but nothing else) from the selected points. */
export function clearPositions(points: TrackPoint[], from: number, to: number): TrackPoint[] {
  const [a, b] = from < to ? [from, to] : [to, from];
  return points.map((p, i) => (i >= a && i <= b ? { ...p, lat: null, lon: null } : p));
}

export function movePoint(points: TrackPoint[], index: number, lat: number, lon: number): TrackPoint[] {
  return points.map((p, i) => (i === index ? { ...p, lat, lon } : p));
}

/** Number of points whose position differs from the original. */
export function countChanged(original: TrackPoint[], current: TrackPoint[]): number {
  let n = 0;
  for (let i = 0; i < original.length; i++) {
    if (original[i].lat !== current[i].lat || original[i].lon !== current[i].lon) n++;
  }
  return n;
}

const EARTH_RADIUS_M = 6371008.8;

/** Straight-line distance in metres between two positions (haversine). */
export function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * For each point, the distance travelled since the previous point that has a
 * position (0 for the first point and for points without a position).
 */
export function stepDistances(points: TrackPoint[]): number[] {
  let prev: TrackPoint | null = null;
  return points.map((p) => {
    if (p.lat === null || p.lon === null) return 0;
    const d = prev ? metresBetween(prev.lat!, prev.lon!, p.lat, p.lon) : 0;
    prev = p;
    return d;
  });
}

/** Total straight-line length of the track in metres. */
export function trackLength(points: TrackPoint[]): number {
  return stepDistances(points).reduce((a, b) => a + b, 0);
}
