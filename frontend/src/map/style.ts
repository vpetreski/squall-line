import type { ExpressionSpecification, StyleSpecification } from "maplibre-gl";

/**
 * A dark, quiet base map on OpenFreeMap's OpenMapTiles vector tiles: land, water, state lines, the road hierarchy
 * and place names, nothing else, so the routes and the weather carry all the colour.
 */
const name: ExpressionSpecification = ["coalesce", ["get", "name:en"], ["get", "name_en"], ["get", "name"]];

export const mapStyle: StyleSpecification = {
  version: 8,
  name: "Squall Line",
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    omt: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
      attribution:
        '<a href="https://openfreemap.org" target="_blank" rel="noreferrer">OpenFreeMap</a> · <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a>',
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#0c0c0f" } },
    { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": "#050507" } },
    {
      id: "park",
      type: "fill",
      source: "omt",
      "source-layer": "park",
      minzoom: 5,
      paint: { "fill-color": "#101013", "fill-opacity": 0.7 },
    },
    {
      id: "urban",
      type: "fill",
      source: "omt",
      "source-layer": "landuse",
      minzoom: 5,
      filter: ["in", ["get", "class"], ["literal", ["residential", "commercial", "industrial", "retail"]]],
      paint: { "fill-color": "#141418" },
    },
    {
      id: "waterway",
      type: "line",
      source: "omt",
      "source-layer": "waterway",
      minzoom: 7,
      paint: { "line-color": "#08080b", "line-width": 1 },
    },
    {
      id: "boundary-state",
      type: "line",
      source: "omt",
      "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
      paint: {
        "line-color": "#2c2c34",
        "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 8, 1.2],
        "line-dasharray": [3, 2],
      },
    },
    {
      id: "boundary-country",
      type: "line",
      source: "omt",
      "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
      paint: { "line-color": "#44444e", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.8, 8, 1.6] },
    },
    {
      id: "road-minor",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 9,
      filter: ["in", ["get", "class"], ["literal", ["secondary", "tertiary", "minor"]]],
      paint: { "line-color": "#1a1a1f", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 14, 2.5] },
    },
    {
      id: "road-primary",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 6,
      filter: ["==", ["get", "class"], "primary"],
      paint: { "line-color": "#202026", "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.4, 12, 2.4] },
    },
    {
      id: "road-trunk",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 4,
      filter: ["==", ["get", "class"], "trunk"],
      paint: { "line-color": "#29292f", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.4, 12, 3] },
    },
    {
      id: "road-motorway",
      type: "line",
      source: "omt",
      "source-layer": "transportation",
      minzoom: 3,
      filter: ["==", ["get", "class"], "motorway"],
      paint: { "line-color": "#36363e", "line-width": ["interpolate", ["linear"], ["zoom"], 3, 0.4, 6, 1, 12, 3.6] },
    },
    {
      id: "place-state",
      type: "symbol",
      source: "omt",
      "source-layer": "place",
      maxzoom: 7,
      filter: ["==", ["get", "class"], "state"],
      layout: {
        "text-field": ["upcase", name],
        "text-font": ["Noto Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, 9, 6, 12],
        "text-letter-spacing": 0.32,
        "text-max-width": 8,
      },
      paint: { "text-color": "#44444d" },
    },
    {
      id: "place-town",
      type: "symbol",
      source: "omt",
      "source-layer": "place",
      minzoom: 7,
      filter: ["in", ["get", "class"], ["literal", ["town"]]],
      layout: { "text-field": name, "text-font": ["Noto Sans Regular"], "text-size": 11 },
      paint: { "text-color": "#6f6f79", "text-halo-color": "#0c0c0f", "text-halo-width": 1.2 },
    },
    {
      id: "place-city",
      type: "symbol",
      source: "omt",
      "source-layer": "place",
      minzoom: 3,
      filter: ["==", ["get", "class"], "city"],
      layout: {
        "text-field": name,
        "text-font": ["Noto Sans Bold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 3, ["match", ["get", "rank"], [1, 2], 11, 9], 8, 14],
        "symbol-sort-key": ["get", "rank"],
      },
      paint: { "text-color": "#9a9aa4", "text-halo-color": "#0c0c0f", "text-halo-width": 1.4 },
    },
  ],
};
