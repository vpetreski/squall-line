/**
 * The corridor heatmap as pixels.
 *
 * The lattice is a regular grid in Web Mercator, the map's own projection, so an image stretched over its four
 * corners lands every cell where its forecast was taken. Each cell is drawn as SUPERSAMPLE x SUPERSAMPLE pixels:
 * the weather is interpolated in space between cell centres and in time between hourly frames, and only then
 * coloured. The risk layer classifies the interpolated weather with the server's own rules, so its regions grow,
 * shrink and drift as the clock moves instead of jumping from hour to hour, and at every cell centre on every
 * hour it is exactly the level the server computed. The corridor's edge fades out over half a cell.
 */
import type { Corridor, Rules, Scale } from "../api/schema";

export type LayerName = "risk" | "wind" | "rain" | "snow";
export type RGBA = [number, number, number, number];
type Stop = [value: number, rgba: RGBA];

/**
 * Pixels per cell, across and down. Odd, so that one pixel's centre sits exactly on each cell's centre ((x + 0.5) /
 * 15 - 0.5 = c for x = 15c + 7) and shows that cell's own forecast with weight 1: with an even count every pixel
 * mixes in a neighbour, and an isolated cell just over a threshold never shows its level anywhere.
 */
export const SUPERSAMPLE = 15;

/** Colour ramps keyed to the rule thresholds, so a colour change on the map is a level change in the rules. */
export const RAMPS: Record<Exclude<LayerName, "risk">, Stop[]> = {
  wind: [
    [0, [56, 189, 248, 0]],
    [15, [56, 189, 248, 0.18]],
    [25, [250, 204, 21, 0.5]],
    [35, [251, 146, 60, 0.62]],
    [45, [239, 68, 68, 0.74]],
    [55, [224, 64, 251, 0.85]],
    [70, [255, 255, 255, 0.9]],
  ],
  rain: [
    [0, [74, 222, 128, 0]],
    [0.01, [74, 222, 128, 0.25]],
    [0.1, [250, 204, 21, 0.5]],
    [0.25, [251, 146, 60, 0.62]],
    [0.5, [239, 68, 68, 0.74]],
    [1.0, [224, 64, 251, 0.85]],
    [2.0, [255, 255, 255, 0.9]],
  ],
  snow: [
    [0, [186, 230, 253, 0]],
    [0.05, [186, 230, 253, 0.3]],
    [0.5, [250, 204, 21, 0.5]],
    [1.0, [251, 146, 60, 0.62]],
    [2.0, [239, 68, 68, 0.74]],
    [3.0, [224, 64, 251, 0.85]],
    [5.0, [255, 255, 255, 0.9]],
  ],
};

/** Risk levels; Low stays clear so the corridor only lights up where the rules do. */
export const RISK_RGBA: RGBA[] = [
  [74, 222, 128, 0],
  [250, 204, 21, 0.42],
  [251, 146, 60, 0.58],
  [239, 68, 68, 0.72],
  [224, 64, 251, 0.85],
];

export function rampColor(stops: Stop[], value: number): RGBA {
  const first = stops[0] as Stop;
  if (value <= first[0]) return first[1];
  for (let i = 1; i < stops.length; i++) {
    const [v1, c1] = stops[i] as Stop;
    if (value <= v1) {
      const [v0, c0] = stops[i - 1] as Stop;
      const t = (value - v0) / (v1 - v0);
      return [
        c0[0] + (c1[0] - c0[0]) * t,
        c0[1] + (c1[1] - c0[1]) * t,
        c0[2] + (c1[2] - c0[2]) * t,
        c0[3] + (c1[3] - c0[3]) * t,
      ];
    }
  }
  return (stops[stops.length - 1] as Stop)[1];
}

const LEVEL_INDEX = { low: 0, moderate: 1, high: 2, severe: 3, no_travel: 4 } as const;

function scaleLevel(scale: Scale): (value: number) => number {
  const k = 10 ** scale.decimals;
  return (value) => {
    const v = Math.round(value * k) / k;
    if (v > scale.no_travel || (scale.no_travel_inclusive && v === scale.no_travel)) return 4;
    if (v >= scale.severe) return 3;
    if (v >= scale.high) return 2;
    if (v >= scale.moderate) return 1;
    return 0;
  };
}

export type Classifier = (wind_mph: number, rain_in_hr: number, snow_in_hr: number) => number;

/** The overall risk level (0 Low to 4 No Travel) by the rules the server publishes, for a truck carrying `loadLb`. */
export function classifier(rules: Rules, loadLb: number): Classifier {
  const wind = scaleLevel(rules.wind);
  const rain = scaleLevel(rules.rain);
  const snow = scaleLevel(rules.snow);
  const raise = new Map<number, number>();
  for (const rule of rules.load_rules) {
    if (loadLb > rule.over_lb) raise.set(LEVEL_INDEX[rule.level], LEVEL_INDEX[rule.raised_to]);
  }
  return (w, r, s) => {
    const base = wind(w);
    return Math.max(raise.get(base) ?? base, rain(r), snow(s));
  };
}

/**
 * Where each pixel takes its weather from: up to four cells (positions in `corridor.cells`) with bilinear weights
 * that sum to one, and how much of the pixel the corridor covers. Only pixels the corridor touches are listed.
 */
export type Raster = {
  width: number;
  height: number;
  scale: number;
  pixels: Uint32Array;
  slots: Int32Array;
  weights: Float32Array;
  coverage: Float32Array;
};

type LatLon = readonly [number, number];
const EARTH_M = 6_378_137;
const FADE = 0.22; // the corridor's edge fades over this fraction of its half-width, inside and out

const mercX = (lon: number) => (lon * Math.PI) / 180;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Distance from every pixel to the nearest route, in units of the corridor's half-width there (1 = the edge).
 * Routes are walked in steps of about a pixel and each step is stamped as a capsule, so this costs the routes'
 * length times the corridor's width, not the image's area times the routes' points.
 */
function corridorDistance(
  corridor: Pick<Corridor, "bounds" | "half_width_km">,
  routes: readonly (readonly LatLon[])[],
  width: number,
  height: number,
): Float32Array {
  const [west, south, east, north] = corridor.bounds;
  const x0 = mercX(west);
  const y0 = mercY(north);
  const sx = width / (mercX(east) - x0);
  const sy = height / (y0 - mercY(south));
  const metresPerPixel = EARTH_M / sx;
  const out = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY);
  for (const points of routes) {
    let last: [number, number] | null = null;
    for (let i = 0; i < points.length; i++) {
      const [lat, lon] = points[i] as LatLon;
      const here: [number, number] = [(mercX(lon) - x0) * sx, (y0 - mercY(lat)) * sy];
      if (last && i < points.length - 1 && Math.hypot(here[0] - last[0], here[1] - last[1]) < 1.5) continue;
      const a = last ?? here;
      last = here;
      const reach = (corridor.half_width_km * 1000) / Math.cos((lat * Math.PI) / 180) / metresPerPixel;
      const pad = reach * (1 + FADE) + 1;
      const xa = Math.max(Math.floor(Math.min(a[0], here[0]) - pad), 0);
      const xb = Math.min(Math.ceil(Math.max(a[0], here[0]) + pad), width - 1);
      const ya = Math.max(Math.floor(Math.min(a[1], here[1]) - pad), 0);
      const yb = Math.min(Math.ceil(Math.max(a[1], here[1]) + pad), height - 1);
      const dx = here[0] - a[0];
      const dy = here[1] - a[1];
      const len2 = dx * dx + dy * dy;
      for (let y = ya; y <= yb; y++) {
        for (let x = xa; x <= xb; x++) {
          const px = x + 0.5 - a[0];
          const py = y + 0.5 - a[1];
          const t = len2 > 0 ? Math.min(Math.max((px * dx + py * dy) / len2, 0), 1) : 0;
          const d = Math.hypot(px - t * dx, py - t * dy) / reach;
          const k = y * width + x;
          if (d < (out[k] as number)) out[k] = d;
        }
      }
    }
  }
  return out;
}

/**
 * `routes`, when given (each as [lat, lon] points), shape the corridor's edge: it follows the band within the
 * corridor's half-width of the routes, as the server drew it, instead of the cells' staircase.
 */
export function raster(
  corridor: Pick<Corridor, "cols" | "rows" | "cells" | "bounds" | "half_width_km">,
  routes: readonly (readonly LatLon[])[] = [],
  scale = SUPERSAMPLE,
): Raster {
  const { cols, rows, cells } = corridor;
  const slotOf = new Int32Array(cols * rows).fill(-1);
  cells.forEach((cell, slot) => {
    slotOf[cell] = slot;
  });
  const width = cols * scale;
  const height = rows * scale;
  const distance = routes.length > 0 ? corridorDistance(corridor, routes, width, height) : null;
  const pixels: number[] = [];
  const slots: number[] = [];
  const weights: number[] = [];
  const coverage: number[] = [];
  const slot = (r: number, c: number) => (r < 0 || c < 0 || r >= rows || c >= cols ? -1 : (slotOf[r * cols + c] ?? -1));
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / scale - 0.5;
    const r0 = Math.floor(v);
    const fy = v - r0;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / scale - 0.5;
      const c0 = Math.floor(u);
      const fx = u - c0;
      const near = [slot(r0, c0), slot(r0, c0 + 1), slot(r0 + 1, c0), slot(r0 + 1, c0 + 1)];
      const w = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      let total = 0;
      for (let i = 0; i < 4; i++) if ((near[i] as number) >= 0) total += w[i] as number;
      // No forecast near enough to draw from, or outside the band.
      const band = distance ? 1 - smoothstep(1 - FADE, 1 + FADE, distance[y * width + x] as number) : 1;
      const cover = band * smoothstep(0, distance ? 0.3 : 0.5, total);
      if (cover < 0.004) continue;
      pixels.push(y * width + x);
      for (let i = 0; i < 4; i++) {
        const s = near[i] as number;
        slots.push(s);
        weights.push(s >= 0 ? (w[i] as number) / total : 0);
      }
      coverage.push(cover);
    }
  }
  return {
    width,
    height,
    scale,
    pixels: Uint32Array.from(pixels),
    slots: Int32Array.from(slots),
    weights: Float32Array.from(weights),
    coverage: Float32Array.from(coverage),
  };
}

type Field = "wind_mph" | "rain_in_hr" | "snow_in_hr";
const FIELD: Record<Exclude<LayerName, "risk">, Field> = { wind: "wind_mph", rain: "rain_in_hr", snow: "snow_in_hr" };

/** A field at every cell at `hours` after departure (0 to frames - 1), linear between hourly frames. */
export function fieldAt(corridor: Corridor, field: Field, hours: number, out?: Float32Array): Float32Array {
  const n = corridor.cells.length;
  const values = out ?? new Float32Array(n);
  const last = corridor.frames - 1;
  const t = Math.min(Math.max(hours, 0), last);
  const k = Math.min(Math.floor(t), last);
  const f = t - k;
  const a = corridor[field][k] ?? [];
  const b = corridor[field][Math.min(k + 1, last)] ?? [];
  for (let i = 0; i < n; i++) values[i] = (a[i] ?? 0) * (1 - f) + (b[i] ?? 0) * f;
  return values;
}

/** The server's own level at every cell on the nearest hourly frame. */
export function riskAt(corridor: Corridor, hours: number): number[] {
  const t = Math.min(Math.max(Math.round(hours), 0), corridor.frames - 1);
  return corridor.risk[t] ?? [];
}

function blend(values: Float32Array, grid: Raster, p: number): number {
  const o = p * 4;
  let v = 0;
  for (let i = 0; i < 4; i++) {
    const s = grid.slots[o + i] as number;
    if (s >= 0) v += (values[s] as number) * (grid.weights[o + i] as number);
  }
  return v;
}

function put(target: Uint8ClampedArray, pixel: number, [r, g, b, a]: RGBA, coverage: number): void {
  const q = pixel * 4;
  target[q] = r;
  target[q + 1] = g;
  target[q + 2] = b;
  target[q + 3] = a * coverage * 255;
}

/**
 * Paint `layer` at `hours` into `target` (grid.width x grid.height RGBA, row 0 at the north). Without a
 * classifier (the rules have not arrived yet) the risk layer shows the server's levels on the nearest hour.
 */
export function paint(
  corridor: Corridor,
  grid: Raster,
  layer: LayerName,
  hours: number,
  target: Uint8ClampedArray,
  classify: Classifier | null,
): void {
  target.fill(0);
  const n = grid.pixels.length;
  if (layer !== "risk") {
    const values = fieldAt(corridor, FIELD[layer], hours);
    const ramp = RAMPS[layer];
    for (let p = 0; p < n; p++)
      put(target, grid.pixels[p] as number, rampColor(ramp, blend(values, grid, p)), grid.coverage[p] as number);
    return;
  }
  if (!classify) {
    const levels = riskAt(corridor, hours);
    for (let p = 0; p < n; p++) {
      let best = 0;
      for (let i = 1; i < 4; i++)
        if ((grid.weights[p * 4 + i] as number) > (grid.weights[p * 4 + best] as number)) best = i;
      const level = levels[grid.slots[p * 4 + best] as number] ?? 0;
      put(target, grid.pixels[p] as number, RISK_RGBA[level] ?? [0, 0, 0, 0], grid.coverage[p] as number);
    }
    return;
  }
  const wind = fieldAt(corridor, "wind_mph", hours);
  const rain = fieldAt(corridor, "rain_in_hr", hours);
  const snow = fieldAt(corridor, "snow_in_hr", hours);
  for (let p = 0; p < n; p++) {
    const level = classify(blend(wind, grid, p), blend(rain, grid, p), blend(snow, grid, p));
    put(target, grid.pixels[p] as number, RISK_RGBA[level] ?? [0, 0, 0, 0], grid.coverage[p] as number);
  }
}
