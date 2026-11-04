/** One GPS sample. lat/lon are null when the sample has no position. */
export interface TrackPoint {
  lat: number | null;
  lon: number | null;
  /** Milliseconds since 1970, or null if the file has no time for it. */
  time: number | null;
  /**
   * True for a point you added on the map. It isn't in the original file,
   * so it gets a new sample with only a time and a position (its time comes
   * from `retime`).
   */
  added?: boolean;
}

/**
 * Moves every point strictly between `from` and `to` onto the straight line
 * joining them. Points are spaced by their recorded time when every point has
 * one (so pauses stay pauses), otherwise evenly. With `onlyAdded`, recorded
 * points (which are locked) stay where they are and only added points move.
 */
export function straighten(points: TrackPoint[], from: number, to: number, onlyAdded = false): TrackPoint[] {
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
    if (i <= a || i >= b || (onlyAdded && !p.added)) return p;
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

/**
 * Removes the GPS position (but nothing else) from the selected points.
 * Added points have nothing but a position, so they are deleted instead.
 */
export function clearPositions(points: TrackPoint[], from: number, to: number): TrackPoint[] {
  const [a, b] = from < to ? [from, to] : [to, from];
  const out: TrackPoint[] = [];
  points.forEach((p, i) => {
    if (i < a || i > b) out.push(p);
    else if (!p.added) out.push({ ...p, lat: null, lon: null });
  });
  // An added point needs recorded points with a position on both sides.
  const hasPos = (p: TrackPoint | undefined) => !!p && p.lat !== null && p.lon !== null;
  const keep = out.map((p, i) => {
    if (!p.added) return true;
    let before = i - 1;
    while (before >= 0 && out[before].added) before--;
    let after = i + 1;
    while (after < out.length && out[after].added) after++;
    return hasPos(out[before]) && hasPos(out[after]);
  });
  return retime(out.filter((_, i) => keep[i]));
}

/** Deletes the added points in the selection (original points are kept). */
export function deleteAdded(points: TrackPoint[], from: number, to: number): TrackPoint[] {
  const [a, b] = from < to ? [from, to] : [to, from];
  return retime(points.filter((p, i) => !(p.added && i >= a && i <= b)));
}

/**
 * Adds a new point between points `after` and `after + 1`, then works out
 * the times of the added points around it (see `retime`).
 */
export function insertPoint(points: TrackPoint[], after: number, lat: number, lon: number): TrackPoint[] {
  if (after < 0 || after >= points.length - 1) {
    throw new Error("A new point has to go between two existing points.");
  }
  const point: TrackPoint = { lat, lon, time: null, added: true };
  return retime([...points.slice(0, after + 1), point, ...points.slice(after + 1)]);
}

/**
 * Gives every added point a time, without touching any recorded time.
 *
 * Added points always sit between two recorded points A and B. Their time is
 * A's time plus the share of the A-to-B time that matches how far along the
 * way from A to B they are (measured along the track, through any other added
 * points). A point a third of the way gets a time a third of the way.
 *
 * Times are rounded to whole seconds, because that's all a FIT file can
 * store. If A or B has no time or no position, the added points get no time.
 */
export function retime(points: TrackPoint[]): TrackPoint[] {
  if (!points.some((p) => p.added)) return points;
  const out = points.slice();
  let i = 0;
  while (i < out.length) {
    if (!out[i].added) {
      i++;
      continue;
    }
    // A run of added points from i to j - 1, between recorded points i - 1 and j.
    let j = i;
    while (j < out.length && out[j].added) j++;
    const a = out[i - 1];
    const b = out[j];
    const usable = (p: TrackPoint | undefined): p is TrackPoint & { lat: number; lon: number; time: number } =>
      !!p && p.lat !== null && p.lon !== null && p.time !== null;
    if (!usable(a) || !usable(b)) {
      for (let k = i; k < j; k++) out[k] = { ...out[k], time: null };
    } else {
      // Distance along the way from A to each added point, and to B.
      const along: number[] = [];
      let total = 0;
      let prev: TrackPoint = a;
      for (let k = i; k <= j; k++) {
        const p = out[k];
        if (p.lat !== null && p.lon !== null) {
          total += metresBetween(prev.lat!, prev.lon!, p.lat, p.lon);
          prev = p;
        }
        along.push(total);
      }
      const n = j - i + 1;
      for (let k = i; k < j; k++) {
        const share = total > 0 ? along[k - i] / total : (k - i + 1) / n;
        const time = Math.round((a.time + (b.time - a.time) * share) / 1000) * 1000;
        if (out[k].time !== time) out[k] = { ...out[k], time };
      }
    }
    i = j;
  }
  return out;
}

/**
 * For each point, the matching point of the original file, or null for
 * points you added.
 */
export function originalsOf(original: TrackPoint[], current: TrackPoint[]): (TrackPoint | null)[] {
  let k = 0;
  return current.map((p) => (p.added ? null : original[k++]));
}

/** Moves one point. Added points nearby get new times to match. */
export function movePoint(points: TrackPoint[], index: number, lat: number, lon: number): TrackPoint[] {
  return retime(points.map((p, i) => (i === index ? { ...p, lat, lon } : p)));
}

/** Number of points whose position differs from the original, and number of added points. */
export function countChanged(original: TrackPoint[], current: TrackPoint[]): { moved: number; added: number } {
  let moved = 0;
  let added = 0;
  originalsOf(original, current).forEach((o, i) => {
    if (!o) added++;
    else if (o.lat !== current[i].lat || o.lon !== current[i].lon) moved++;
  });
  return { moved, added };
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

/** A part of the track you edited, with its length before and after. */
export interface EditedStretch {
  /** First and last point (indexes in the edited track), both unchanged where possible. */
  from: number;
  to: number;
  /** Time of the first point, if it has one. */
  time: number | null;
  /** Length in metres of this part of the GPS track as recorded, and after editing. */
  before: number;
  after: number;
  moved: number;
  added: number;
}

/**
 * Splits your edits into stretches: each runs from the last unchanged point
 * before an edit to the first unchanged point after it, so its length can be
 * compared with the same stretch of the recorded track.
 */
export function editedStretches(original: TrackPoint[], current: TrackPoint[]): EditedStretch[] {
  const originals = originalsOf(original, current);
  // Where each point of `current` sits in `original` (added points: the recorded point before).
  const originalIndex: number[] = [];
  let k = -1;
  originals.forEach((o) => {
    if (o) k++;
    originalIndex.push(k);
  });
  const changed = current.map((p, i) => {
    const o = originals[i];
    return !o || o.lat !== p.lat || o.lon !== p.lon;
  });
  const isAnchor = (i: number) => !changed[i] && current[i].lat !== null && current[i].lon !== null;

  const out: EditedStretch[] = [];
  let i = 0;
  while (i < current.length) {
    if (!changed[i]) {
      i++;
      continue;
    }
    let from = i - 1;
    while (from >= 0 && !isAnchor(from)) from--;
    let to = i;
    while (to < current.length && !isAnchor(to)) to++;
    from = Math.max(0, from);
    to = Math.min(current.length - 1, to);
    let moved = 0;
    let added = 0;
    for (let j = from; j <= to; j++) {
      if (!originals[j]) added++;
      else if (changed[j]) moved++;
    }
    const oFrom = Math.max(0, originalIndex[from]);
    const oTo = originalIndex[to];
    out.push({
      from,
      to,
      time: current[from].time,
      before: trackLength(original.slice(oFrom, oTo + 1)),
      after: trackLength(current.slice(from, to + 1)),
      moved,
      added,
    });
    // The anchor that ends this stretch can start the next one.
    i = to + 1;
  }
  return out;
}

/**
 * Splits the track into the lines to draw on the map, breaking it only where
 * the GPS really had no position for a while.
 *
 * Some files (like Strava app recordings, and files merged from them) store
 * heart rate, distance and position as separate samples with the same time,
 * so most samples have no position of their own. Those don't break the line:
 * a sample without a position is only a gap if its time falls strictly
 * between the two positions around it (or it has no time at all).
 */
export function lineParts(points: TrackPoint[]): [number, number][][] {
  const parts: [number, number][][] = [];
  let current: [number, number][] = [];
  let lastTime: number | null = null;
  // Times of position-less samples since the last point with a position.
  let pending: (number | null)[] = [];
  for (const p of points) {
    if (p.lat === null || p.lon === null) {
      pending.push(p.time);
      continue;
    }
    const gap = pending.some((t) => t === null || ((lastTime === null || t !== lastTime) && t !== p.time));
    if (gap && current.length) {
      parts.push(current);
      current = [];
    }
    current.push([p.lat, p.lon]);
    lastTime = p.time;
    pending = [];
  }
  if (current.length) parts.push(current);
  return parts;
}
