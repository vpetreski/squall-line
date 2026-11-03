import type { Feature, FeatureCollection } from "geojson";
import {
  type CanvasSource,
  type ExpressionSpecification,
  type GeoJSONSource,
  MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
} from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRules } from "../api/hooks";
import type { Route } from "../api/schema";
import { bounds, Line } from "../lib/geo";
import { classifier, paint, raster } from "../lib/heatmap";
import { decodePolyline } from "../lib/polyline";
import { LEVEL_COLOR, LEVEL_SHORT } from "../lib/risk";
import { duration } from "../lib/time";
import { mileAt } from "../lib/timeline";
import { useStore } from "../state/store";
import { FocusCard } from "./FocusCard";
import { routeGradient } from "./gradient";
import { checkpointFeatures, OTHER_CHECKPOINTS, stackRoutes } from "./layers";
import { mapStyle } from "./style";

// MapLibre finds its worker next to its own module by default, which a bundler moves; hand it the emitted file.
setWorkerUrl(workerUrl);

const LABELS_ABOVE = "place-state"; // data layers go under the place names, markers over them
const HEATMAP_MEASURE = "heatmap";
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const LEVEL_MATCH: ExpressionSpecification = [
  "match",
  ["get", "level"],
  "moderate",
  LEVEL_COLOR.moderate,
  "high",
  LEVEL_COLOR.high,
  "severe",
  LEVEL_COLOR.severe,
  "no_travel",
  LEVEL_COLOR.no_travel,
  LEVEL_COLOR.low,
];

export type RouteGeometry = { route: Route; line: Line };

function lineFeature(geometry: RouteGeometry): Feature {
  return {
    type: "Feature",
    properties: { id: geometry.route.id },
    geometry: { type: "LineString", coordinates: geometry.line.points.map(([lat, lon]) => [lon, lat]) },
  };
}

function summary(route: Route): string {
  const m = route.miles;
  const worst =
    m.no_travel > 0
      ? `${Math.round(m.no_travel)} MI ${LEVEL_SHORT.no_travel}`
      : m.severe > 0
        ? `${Math.round(m.severe)} MI ${LEVEL_SHORT.severe}`
        : m.high > 0
          ? `${Math.round(m.high)} MI ${LEVEL_SHORT.high}`
          : m.moderate > 0
            ? `${Math.round(m.moderate)} MI ${LEVEL_SHORT.moderate}`
            : "ALL LOW";
  return `${duration(route.trip_s).toUpperCase()} · ${worst}`;
}

function routeLabel(route: Route, onSelect: () => void): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "route-tag";
  el.dataset.route = route.id;
  const id = document.createElement("span");
  id.className = "route-tag-id";
  id.textContent = route.id;
  const text = document.createElement("span");
  text.textContent = summary(route);
  el.append(id, text);
  el.style.setProperty("--level", LEVEL_COLOR[route.worst]);
  el.addEventListener("click", (event) => {
    event.stopPropagation();
    onSelect();
  });
  return el;
}

export function MapView() {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const image = useRef<ImageData | null>(null);
  const markers = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);
  const plan = useStore((s) => s.plan);
  const selectedId = useStore((s) => s.selectedId);
  const hoveredId = useStore((s) => s.hoveredId);
  const hours = useStore((s) => s.hours);
  const layer = useStore((s) => s.layer);
  const focus = useStore((s) => s.focus);

  const rules = useRules().data;

  const geometries = useMemo<RouteGeometry[]>(
    () => (plan ? plan.routes.map((route) => ({ route, line: new Line(decodePolyline(route.geometry)) })) : []),
    [plan],
  );
  const grid = useMemo(
    () =>
      plan
        ? raster(
            plan.corridor,
            geometries.map((g) => g.line.points),
          )
        : null,
    [plan, geometries],
  );
  const classify = useMemo(() => (plan && rules ? classifier(rules, plan.request.load_lb) : null), [plan, rules]);

  // The map itself, once.
  useEffect(() => {
    if (!container.current) return;
    const map = new MapLibreMap({
      container: container.current,
      style: mapStyle,
      center: [-96.5, 38.6],
      zoom: 3.55,
      minZoom: 2.5,
      maxZoom: 14,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      fadeDuration: 0,
    });
    map.touchZoomRotate.disableRotation();
    // On a phone the map is one block of a scrolling page: one finger scrolls the page, two move the map.
    const phone = window.matchMedia("(max-width: 1023px)");
    const gestures = () => (phone.matches ? map.cooperativeGestures.enable() : map.cooperativeGestures.disable());
    gestures();
    phone.addEventListener("change", gestures);
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;
    map.on("load", () => {
      for (const id of ["checkpoints", OTHER_CHECKPOINTS, "stops", "trucks", "endpoints", "focus"]) {
        map.addSource(id, { type: "geojson", data: EMPTY });
      }
      // The other routes' checkpoints sit among the route lines, under the selected one (see stackRoutes).
      map.addLayer(
        {
          id: OTHER_CHECKPOINTS,
          type: "circle",
          source: OTHER_CHECKPOINTS,
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 1.6, 6, 2.6, 10, 4],
            "circle-color": LEVEL_MATCH,
            "circle-opacity": 0.5,
            "circle-stroke-color": "#08080a",
            "circle-stroke-width": 0.75,
            "circle-stroke-opacity": 0.5,
          },
        },
        LABELS_ABOVE,
      );
      map.addLayer({
        id: "stops",
        type: "circle",
        source: "stops",
        paint: {
          "circle-radius": 5.5,
          "circle-color": "#08080a",
          "circle-stroke-color": "#ededf0",
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "checkpoints",
        type: "circle",
        source: "checkpoints",
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, 2.6, 6, 4, 10, 6],
          "circle-color": LEVEL_MATCH,
          "circle-stroke-color": "#08080a",
          "circle-stroke-width": 1,
        },
      });
      map.addLayer({
        id: "focus",
        type: "circle",
        source: "focus",
        paint: {
          "circle-radius": 9,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "endpoints",
        type: "circle",
        source: "endpoints",
        paint: {
          "circle-radius": 6.5,
          "circle-color": ["case", ["==", ["get", "kind"], "origin"], "#08080a", "#ededf0"],
          "circle-stroke-color": ["case", ["==", ["get", "kind"], "origin"], "#ededf0", "#08080a"],
          "circle-stroke-width": 2.5,
        },
      });
      map.addLayer({
        id: "trucks",
        type: "circle",
        source: "trucks",
        paint: {
          "circle-radius": ["case", ["get", "selected"], 7, 4.5],
          "circle-color": ["case", ["get", "selected"], "#ffffff", "#8f8f99"],
          "circle-stroke-color": "#08080a",
          "circle-stroke-width": 2,
        },
      });
      // Place names make way for the markers: invisible symbols on the endpoints and checkpoints take part in label
      // placement, so a city name at a marker moves aside (or hides) instead of being drawn through.
      map.addImage("keep-clear", { width: 2, height: 2, data: new Uint8Array(2 * 2 * 4) });
      map.addLayer({
        id: "endpoints-clear",
        type: "symbol",
        source: "endpoints",
        layout: { "icon-image": "keep-clear", "icon-size": 9, "icon-allow-overlap": true },
        paint: { "icon-opacity": 0 },
      });
      map.addLayer({
        id: "checkpoints-clear",
        type: "symbol",
        source: "checkpoints",
        layout: {
          "icon-image": "keep-clear",
          "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 3, 6, 4.5, 10, 6.5],
          "icon-allow-overlap": true,
        },
        paint: { "icon-opacity": 0 },
      });
      const pointer = () => {
        map.getCanvas().style.cursor = "pointer";
      };
      const plain = () => {
        map.getCanvas().style.cursor = "";
      };
      map.on("mouseenter", "checkpoints", pointer);
      map.on("mouseleave", "checkpoints", () => {
        plain();
        const f = useStore.getState().focus;
        if (f && !f.pinned) useStore.getState().setFocus(null);
      });
      map.on("mousemove", "checkpoints", (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const { route, index } = feature.properties as { route: string; index: number };
        const f = useStore.getState().focus;
        if (f?.pinned) return;
        if (f?.routeId !== route || f.index !== index)
          useStore.getState().setFocus({ routeId: route, index, pinned: false });
      });
      map.on("click", "checkpoints", (event) => {
        const feature = event.features?.[0];
        if (!feature) return;
        const { route, index } = feature.properties as { route: string; index: number };
        const state = useStore.getState();
        const checkpoint = state.plan?.routes.find((r) => r.id === route)?.checkpoints[index];
        state.setFocus({ routeId: route, index, pinned: true });
        if (checkpoint && state.plan) {
          const elapsed = (Date.parse(checkpoint.eta) - Date.parse(state.plan.request.departure)) / 3_600_000;
          state.setHours(Math.min(Math.max(elapsed, 0), state.plan.corridor.frames - 1));
        }
      });
      const routeLayers = () => ["A", "B", "C"].map((id) => `route-${id}`).filter((id) => map.getLayer(id));
      map.on("click", (event) => {
        if (map.queryRenderedFeatures(event.point, { layers: ["checkpoints"] }).length > 0) return;
        const layers = routeLayers();
        const route = layers.length ? map.queryRenderedFeatures(event.point, { layers })[0] : undefined;
        const id = route?.properties?.id as string | undefined;
        if (id) useStore.getState().select(id);
        else if (useStore.getState().focus?.pinned) useStore.getState().setFocus(null);
      });
      map.on("mousemove", (event) => {
        const layers = routeLayers();
        if (layers.length === 0 || map.queryRenderedFeatures(event.point, { layers: ["checkpoints"] }).length > 0)
          return;
        const over = map.queryRenderedFeatures(event.point, { layers }).length > 0;
        map.getCanvas().style.cursor = over ? "pointer" : "";
      });
      setReady(true);
    });
    return () => {
      phone.removeEventListener("change", gestures);
      setReady(false);
      for (const m of markers.current) m.remove();
      markers.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // A new plan: corridor, routes, labels, endpoints; then fit the view.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    for (const m of markers.current) m.remove();
    markers.current = [];
    for (const l of map.getStyle().layers) {
      if (l.id.startsWith("route-")) map.removeLayer(l.id);
    }
    for (const id of Object.keys(map.getStyle().sources)) {
      if (id.startsWith("route-")) map.removeSource(id);
    }
    if (map.getLayer("corridor")) map.removeLayer("corridor");
    if (map.getSource("corridor")) map.removeSource("corridor");
    if (!plan) return;

    const [west, south, east, north] = plan.corridor.bounds;
    const el = document.createElement("canvas");
    el.width = grid?.width ?? 1;
    el.height = grid?.height ?? 1;
    canvas.current = el;
    image.current = null;
    map.addSource("corridor", {
      type: "canvas",
      canvas: el,
      animate: false,
      coordinates: [
        [west, north],
        [east, north],
        [east, south],
        [west, south],
      ],
    });
    map.addLayer(
      {
        id: "corridor",
        type: "raster",
        source: "corridor",
        paint: { "raster-opacity": 0.92, "raster-fade-duration": 0, "raster-resampling": "linear" },
      },
      "boundary-state",
    );

    // Unselected routes first, so the selected one ends up drawn on top.
    for (const g of geometries) {
      const id = g.route.id;
      map.addSource(`route-${id}`, { type: "geojson", data: lineFeature(g), lineMetrics: true });
      map.addLayer(
        {
          id: `route-${id}-casing`,
          type: "line",
          source: `route-${id}`,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": "#050506", "line-width": 7 },
        },
        LABELS_ABOVE,
      );
      map.addLayer(
        {
          id: `route-${id}`,
          type: "line",
          source: `route-${id}`,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-width": 3, "line-gradient": routeGradient(g.route, g.line) },
        },
        LABELS_ABOVE,
      );
      const spot = g.line.at(g.route.rank === 1 ? 0.5 : g.route.rank === 2 ? 0.36 : 0.64);
      const marker = new Marker({
        element: routeLabel(g.route, () => useStore.getState().select(id)),
        anchor: "bottom",
        offset: [0, -8],
      })
        .setLngLat([spot[1], spot[0]])
        .addTo(map);
      markers.current.push(marker);
    }

    const { origin, destination } = plan.request;
    (map.getSource("endpoints") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { kind: "origin" },
          geometry: { type: "Point", coordinates: [origin.lon, origin.lat] },
        },
        {
          type: "Feature",
          properties: { kind: "destination" },
          geometry: { type: "Point", coordinates: [destination.lon, destination.lat] },
        },
      ],
    });

    const all = geometries.flatMap((g) => g.line.points);
    if (all.length > 0) {
      const narrow = window.matchMedia("(max-width: 1023px)").matches;
      map.fitBounds(bounds(all), {
        padding: narrow ? { top: 48, bottom: 56, left: 28, right: 28 } : { top: 80, bottom: 185, left: 80, right: 80 },
        duration: 900,
      });
    }
  }, [plan, geometries, grid, ready]);

  // Selection: the chosen route on top and wider with its checkpoints and stops, the others' checkpoints dimmed.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !plan) return;
    stackRoutes(
      map,
      geometries.map((g) => g.route.id),
      selectedId,
      LABELS_ABOVE,
    );
    for (const g of geometries) {
      const id = g.route.id;
      const selected = id === selectedId;
      const lit = selected || id === hoveredId;
      if (!map.getLayer(`route-${id}`)) continue;
      map.setPaintProperty(`route-${id}`, "line-width", selected ? 5.5 : lit ? 4 : 3);
      map.setPaintProperty(`route-${id}`, "line-opacity", selected ? 1 : lit ? 0.85 : 0.42);
      map.setPaintProperty(`route-${id}-casing`, "line-width", selected ? 10 : 7);
      map.setPaintProperty(`route-${id}-casing`, "line-opacity", selected ? 1 : 0.6);
    }
    for (const m of markers.current) {
      const el = m.getElement();
      el.dataset.selected = String(el.dataset.route === selectedId);
    }
    const route = plan.routes.find((r) => r.id === selectedId);
    const checkpoints = checkpointFeatures(plan, selectedId);
    (map.getSource("checkpoints") as GeoJSONSource).setData(checkpoints.selected);
    (map.getSource(OTHER_CHECKPOINTS) as GeoJSONSource).setData(checkpoints.others);
    // A route lit from its card lights its checkpoints too.
    const hovered: ExpressionSpecification = ["case", ["==", ["get", "route"], hoveredId ?? ""], 0.9, 0.5];
    map.setPaintProperty(OTHER_CHECKPOINTS, "circle-opacity", hovered);
    map.setPaintProperty(OTHER_CHECKPOINTS, "circle-stroke-opacity", hovered);
    (map.getSource("stops") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: (route?.stops ?? []).map((s) => ({
        type: "Feature",
        properties: { kind: s.kind },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      })),
    });
  }, [plan, geometries, selectedId, hoveredId, ready]);

  // Time and layer: repaint the heatmap and move the trucks.
  useEffect(() => {
    const map = mapRef.current;
    const el = canvas.current;
    if (!map || !ready || !plan || !el) return;
    const source = map.getSource("corridor") as CanvasSource | undefined;
    const context = el.getContext("2d");
    if (!source || !context || !grid) return;
    image.current ??= context.createImageData(el.width, el.height);
    const started = performance.now();
    paint(plan.corridor, grid, layer, hours, image.current.data, classify);
    context.putImageData(image.current, 0, 0);
    // The main thread's cost of one clock step, as a "heatmap" entry for performance observers (the speed test
    // reads it); cleared at once so a long session does not pile entries up.
    performance.measure(HEATMAP_MEASURE, { start: started });
    performance.clearMeasures(HEATMAP_MEASURE);
    source.play();
    map.once("render", () => source.pause());

    const elapsed = hours * 3600;
    (map.getSource("trucks") as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: geometries.map((g) => {
        const fraction = mileAt(g.route.timeline, elapsed) / (g.route.distance_mi || 1);
        const [lat, lon] = g.line.at(fraction);
        return {
          type: "Feature",
          properties: { id: g.route.id, selected: g.route.id === selectedId },
          geometry: { type: "Point", coordinates: [lon, lat] },
        };
      }),
    });
  }, [plan, geometries, grid, classify, hours, layer, selectedId, ready]);

  // The focused checkpoint's ring.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const checkpoint = focus ? plan?.routes.find((r) => r.id === focus.routeId)?.checkpoints[focus.index] : undefined;
    (map.getSource("focus") as GeoJSONSource).setData(
      checkpoint
        ? {
            type: "Feature",
            properties: {},
            geometry: { type: "Point", coordinates: [checkpoint.lon, checkpoint.lat] },
          }
        : EMPTY,
    );
  }, [focus, plan, ready]);

  return (
    <section className="relative h-full w-full" aria-label="Map of the routes and the weather">
      <div ref={container} className="absolute inset-0" data-testid="map" />
      {ready && mapRef.current && plan ? <FocusCard map={mapRef.current} plan={plan} /> : null}
    </section>
  );
}
