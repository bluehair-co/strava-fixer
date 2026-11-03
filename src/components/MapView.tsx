"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { TrackPoint } from "@/lib/track";

export interface Selection {
  from: number;
  to: number;
}

interface Props {
  original: TrackPoint[];
  points: TrackPoint[];
  selection: Selection | null;
  onSelect: (index: number, extend: boolean) => void;
  onMove: (index: number, lat: number, lon: number) => void;
}

const COLORS = {
  original: "#9aa0a6",
  track: "#fc4c02",
  point: "#fc4c02",
  selected: "#1a73e8",
};

function toLatLngs(points: TrackPoint[]): L.LatLngExpression[][] {
  // Split the line wherever a point has no position, so gaps show as gaps.
  const parts: L.LatLngExpression[][] = [[]];
  for (const p of points) {
    if (p.lat === null || p.lon === null) {
      if (parts[parts.length - 1].length) parts.push([]);
    } else {
      parts[parts.length - 1].push([p.lat, p.lon]);
    }
  }
  return parts.filter((part) => part.length > 0);
}

export default function MapView({ original, points, selection, onSelect, onMove }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.LayerGroup | null>(null);
  const callbacks = useRef({ onSelect, onMove });

  useEffect(() => {
    callbacks.current = { onSelect, onMove };
  });

  // Create the map once.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, { preferCanvas: true });
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
    return () => {
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
    const line = L.polyline(toLatLngs(points), { color: COLORS.track, weight: 3 }).addTo(layers);

    const lo = selection ? Math.min(selection.from, selection.to) : -1;
    const hi = selection ? Math.max(selection.from, selection.to) : -1;

    points.forEach((p, i) => {
      if (p.lat === null || p.lon === null) return;
      const selected = i >= lo && i <= hi;
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: selected ? 6 : 4,
        color: selected ? COLORS.selected : COLORS.point,
        fillColor: "#fff",
        fillOpacity: 1,
        weight: 2,
        bubblingMouseEvents: false,
      }).addTo(layers);
      marker.bindTooltip(
        `Point ${i + 1}${p.time !== null ? ` · ${new Date(p.time).toLocaleTimeString()}` : ""}`,
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
          const here = map.mouseEventToContainerPoint(ev);
          if (!moved && here.distanceTo(start) < 4) return;
          moved = true;
          const latlng = map.containerPointToLatLng(here);
          marker.setLatLng(latlng);
          line.setLatLngs(
            toLatLngs(points.map((q, j) => (j === i ? { ...q, lat: latlng.lat, lon: latlng.lng } : q))),
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
  }, [original, points, selection]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
