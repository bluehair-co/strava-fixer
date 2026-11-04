"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

export interface MapTrack {
  /** Parts of the line; a new part starts after a gap in the GPS. */
  parts: [number, number][][];
  color: string;
  weight: number;
  opacity?: number;
  label: string;
}

/** A map showing several tracks at once, each in its own colour. Read-only. */
export default function TracksMap({ tracks, fitKey }: { tracks: MapTrack[]; fitKey: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.LayerGroup | null>(null);
  const tracksRef = useRef(tracks);

  useEffect(() => {
    tracksRef.current = tracks;
  });

  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, { preferCanvas: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.setView([0, 0], 2);
    mapRef.current = map;
    layersRef.current = L.layerGroup().addTo(map);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Zoom to all tracks when the set of files changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const all = tracksRef.current.flatMap((t) => t.parts.flat());
    if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [20, 20] });
  }, [fitKey]);

  useEffect(() => {
    const layers = layersRef.current;
    if (!layers) return;
    layers.clearLayers();
    for (const t of tracks) {
      if (!t.parts.length) continue;
      L.polyline(t.parts, { color: t.color, weight: t.weight, opacity: t.opacity ?? 0.9 })
        .bindTooltip(t.label, { sticky: true })
        .addTo(layers);
    }
  }, [tracks]);

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}
