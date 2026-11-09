"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { keptRange, NO_CROP, type Crop } from "@/lib/crop";
import { lineParts, type TrackPoint } from "@/lib/track";

export interface Selection {
  from: number;
  to: number;
}

interface Props {
  original: TrackPoint[];
  points: TrackPoint[];
  selection: Selection | null;
  /** Points outside the crop are drawn greyed out. */
  crop?: Crop;
  onSelect: (index: number, extend: boolean) => void;
  /** Called after shift+dragging a box: the first and last point inside it. */
  onBoxSelect: (from: number, to: number) => void;
  onMove: (index: number, lat: number, lon: number) => void;
  /** When true, recorded points can't be dragged (added points still can). */
  locked?: boolean;
  /** When true, clicking the map adds a point there. */
  addMode?: boolean;
  /** Add a point at lat/lon between points `after` and `after + 1`. */
  onInsert?: (after: number, lat: number, lon: number) => void;
}

const COLORS = {
  original: "#9aa0a6",
  track: "#fc4c02",
  point: "#fc4c02",
  selected: "#1a73e8",
  added: "#0b8043",
  cropped: "#80868b",
};

/** How close (in screen pixels) a press must be to a point to count as on it. */
const HIT_RADIUS_PX = 8;

function toLatLngs(points: TrackPoint[]): L.LatLngExpression[][] {
  // Split the line only where the GPS really had no position, so gaps show as gaps.
  return lineParts(points);
}

/**
 * The stretch of track (between points i and i + 1) closest on screen to
 * `at`, or -1 if there is none. Stretches across a gap in the GPS don't count.
 */
function nearestStretch(map: L.Map, points: TrackPoint[], at: L.Point): number {
  let best = -1;
  let bestDist = Infinity;
  let prev: L.Point | null = null;
  points.forEach((p, i) => {
    if (p.lat === null || p.lon === null) {
      prev = null;
      return;
    }
    const here = map.latLngToContainerPoint([p.lat, p.lon]);
    if (prev) {
      const d = L.LineUtil.pointToSegmentDistance(at, prev, here);
      if (d < bestDist) {
        bestDist = d;
        best = i - 1;
      }
    }
    prev = here;
  });
  return best;
}

export default function MapView({ original, points, selection, crop = NO_CROP, onSelect, onBoxSelect, onMove, addMode = false, onInsert, locked = false }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.LayerGroup | null>(null);
  const callbacks = useRef({ onSelect, onBoxSelect, onMove, onInsert });
  const pointsRef = useRef(points);
  const addModeRef = useRef(addMode);

  useEffect(() => {
    callbacks.current = { onSelect, onBoxSelect, onMove, onInsert };
    pointsRef.current = points;
    addModeRef.current = addMode;
  });

  // A crosshair shows that clicking will add a point.
  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getContainer().style.cursor = addMode ? "crosshair" : "";
  }, [addMode]);

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    // boxZoom is Leaflet's own shift+drag; we use shift+drag for selecting instead.
    const map = L.map(containerRef.current, { preferCanvas: true, boxZoom: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    const valid = original.filter((p) => p.lat !== null && p.lon !== null) as { lat: number; lon: number }[];
    if (valid.length) {
      map.fitBounds(L.latLngBounds(valid.map((p) => [p.lat, p.lon])), { padding: [20, 20] });
    } else {
      map.setView([0, 0], 2);
    }
    mapRef.current = map;
    layersRef.current = L.layerGroup().addTo(map);

    // Shift+drag on an empty part of the map draws a box and selects the
    // points inside it. (Shift+click on a point still extends the selection.)
    const container = map.getContainer();
    const onPress = (ev: MouseEvent) => {
      if (!ev.shiftKey || ev.button !== 0) return;
      const start = map.mouseEventToContainerPoint(ev);
      const onAPoint = pointsRef.current.some(
        (p) =>
          p.lat !== null &&
          p.lon !== null &&
          map.latLngToContainerPoint([p.lat, p.lon]).distanceTo(start) <= HIT_RADIUS_PX,
      );
      if (onAPoint) return;
      // Stop the map from panning; we're drawing a box instead.
      ev.preventDefault();
      ev.stopPropagation();
      const startLatLng = map.containerPointToLatLng(start);
      const box = L.rectangle(L.latLngBounds(startLatLng, startLatLng), {
        color: COLORS.selected,
        weight: 1,
        dashArray: "4 4",
        fillOpacity: 0.1,
        interactive: false,
      }).addTo(map);
      const onMoveBox = (e: MouseEvent) => {
        box.setBounds(L.latLngBounds(startLatLng, map.mouseEventToLatLng(e)));
      };
      const onRelease = (e: MouseEvent) => {
        document.removeEventListener("mousemove", onMoveBox);
        document.removeEventListener("mouseup", onRelease);
        const bounds = L.latLngBounds(startLatLng, map.mouseEventToLatLng(e));
        box.remove();
        let from = -1;
        let to = -1;
        pointsRef.current.forEach((p, i) => {
          if (p.lat === null || p.lon === null || !bounds.contains([p.lat, p.lon])) return;
          if (from < 0) from = i;
          to = i;
        });
        if (from >= 0) callbacks.current.onBoxSelect(from, to);
      };
      document.addEventListener("mousemove", onMoveBox);
      document.addEventListener("mouseup", onRelease);
    };
    // Capture phase, so we see the press before Leaflet starts panning.
    container.addEventListener("mousedown", onPress, true);

    // In "add points" mode, a click adds a point to the nearest stretch of track.
    map.on("click", (e: L.LeafletMouseEvent) => {
      if (!addModeRef.current || e.originalEvent.shiftKey) return;
      const after = nearestStretch(map, pointsRef.current, e.containerPoint);
      if (after >= 0) callbacks.current.onInsert?.(after, e.latlng.lat, e.latlng.lng);
    });

    // The map may start in a hidden tab; redraw it when it becomes visible.
    const resize = new ResizeObserver(() => map.invalidateSize());
    resize.observe(container);

    return () => {
      resize.disconnect();
      container.removeEventListener("mousedown", onPress, true);
      map.remove();
      mapRef.current = null;
    };
  }, [original]);

  // Redraw the track whenever the points or selection change.
  useEffect(() => {
    const map = mapRef.current;
    const layers = layersRef.current;
    if (!map || !layers) return;
    layers.clearLayers();

    L.polyline(toLatLngs(original), { color: COLORS.original, weight: 3, dashArray: "4 6" }).addTo(layers);
    // The parts cropped off are grey; the part that's kept is orange.
    const [first, last] = keptRange(points, crop) ?? [points.length, points.length - 1];
    const cut = { color: COLORS.cropped, weight: 3, opacity: 0.6 };
    if (first > 0) L.polyline(toLatLngs(points.slice(0, first + 1)), cut).addTo(layers);
    if (last < points.length - 1) L.polyline(toLatLngs(points.slice(Math.max(0, last))), cut).addTo(layers);
    const kept = (pts: TrackPoint[]) => pts.slice(first, last + 1);
    const line = L.polyline(toLatLngs(kept(points)), { color: COLORS.track, weight: 3 }).addTo(layers);

    const lo = selection ? Math.min(selection.from, selection.to) : -1;
    const hi = selection ? Math.max(selection.from, selection.to) : -1;

    points.forEach((p, i) => {
      if (p.lat === null || p.lon === null) return;
      const selected = i >= lo && i <= hi;
      const isCut = i < first || i > last;
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: selected ? 6 : p.added ? 5 : isCut ? 3 : 4,
        color: selected ? COLORS.selected : isCut ? COLORS.cropped : p.added ? COLORS.added : COLORS.point,
        fillColor: "#fff",
        fillOpacity: 1,
        weight: 2,
        bubblingMouseEvents: false,
      }).addTo(layers);
      marker.bindTooltip(
        `${p.added ? "Added point" : "Point"} ${i + 1}${p.time !== null ? ` · ${new Date(p.time).toLocaleTimeString()}` : ""}${locked && !p.added ? " · locked" : ""}${isCut ? " · cropped off" : ""}`,
        { direction: "top" },
      );

      // Press on a point and drag to move it; press and release to select it.
      marker.on("mousedown", (e: L.LeafletMouseEvent) => {
        L.DomEvent.preventDefault(e.originalEvent);
        const start = e.containerPoint;
        let moved = false;
        map.dragging.disable();
        // Listen on the whole page: while dragging, the pointer is over the
        // marker itself, which would otherwise swallow the map's events.
        const onMouseMove = (ev: MouseEvent) => {
          // A locked point can be clicked to select it, but not dragged.
          if (locked && !p.added) return;
          const here = map.mouseEventToContainerPoint(ev);
          if (!moved && here.distanceTo(start) < 4) return;
          moved = true;
          const latlng = map.containerPointToLatLng(here);
          marker.setLatLng(latlng);
          line.setLatLngs(
            toLatLngs(kept(points.map((q, j) => (j === i ? { ...q, lat: latlng.lat, lon: latlng.lng } : q)))),
          );
        };
        const onMouseUp = (ev: MouseEvent) => {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          map.dragging.enable();
          if (moved) {
            const latlng = map.mouseEventToLatLng(ev);
            callbacks.current.onMove(i, latlng.lat, latlng.lng);
          } else {
            callbacks.current.onSelect(i, ev.shiftKey);
          }
        };
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      });
    });
  }, [original, points, selection, locked, crop]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
