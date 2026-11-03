import { describe, expect, it } from "vitest";
import type { Corridor } from "../api/schema";
import { PLANS, RULES } from "../test/fixtures";
import { classifier, paint, RAMPS, RISK_RGBA, rampColor, raster, SUPERSAMPLE } from "./heatmap";
import { decodePolyline } from "./polyline";

describe("classifier", () => {
  it("gives the server's level at every corridor cell on every hour of a real plan", () => {
    for (const [name, plan] of Object.entries(PLANS)) {
      const classify = classifier(RULES, plan.request.load_lb);
      const c = plan.corridor;
      const wrong: string[] = [];
      for (let f = 0; f < c.frames; f++) {
        for (let i = 0; i < c.cells.length; i++) {
          const got = classify(c.wind_mph[f]?.[i] ?? Number.NaN, c.rain_in_hr[f]?.[i] ?? 0, c.snow_in_hr[f]?.[i] ?? 0);
          if (got !== c.risk[f]?.[i]) wrong.push(`${name} hour ${f} cell ${i}: ${got} != ${c.risk[f]?.[i]}`);
        }
      }
      expect(wrong).toEqual([]);
    }
  });

  it("paints the server's level on every corridor cell's centre pixel on every hour of a real plan", () => {
    for (const [name, plan] of Object.entries(PLANS)) {
      const c = plan.corridor;
      const grid = raster(
        c,
        plan.routes.map((r) => decodePolyline(r.geometry)),
      );
      const target = new Uint8ClampedArray(grid.width * grid.height * 4);
      const classify = classifier(RULES, plan.request.load_lb);
      const wrong: string[] = [];
      for (let f = 0; f < c.frames; f++) {
        paint(c, grid, "risk", f, target, classify);
        c.cells.forEach((cell, slot) => {
          const x = Math.floor(((cell % c.cols) + 0.5) * grid.scale);
          const y = Math.floor((Math.floor(cell / c.cols) + 0.5) * grid.scale);
          const got = levelOf(at(target, grid.width, x, y));
          if (got !== c.risk[f]?.[slot]) wrong.push(`${name} hour ${f} cell ${cell}: ${got} != ${c.risk[f]?.[slot]}`);
        });
      }
      expect(wrong).toEqual([]);
    }
  });

  it("covers every level in the stormy fixture, so the check above means something", () => {
    const levels = new Set(PLANS["chicago-atlanta"]?.corridor.risk.flat());
    expect([...levels].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps the table's bounds and the load rules", () => {
    const light = classifier(RULES, 20_000);
    expect(light(24.9, 0, 0)).toBe(0);
    expect(light(25, 0, 0)).toBe(1);
    expect(light(54.9, 0, 0)).toBe(3);
    expect(light(55, 0, 0)).toBe(4); // wind's No Travel bound is inclusive
    expect(light(54.96, 0, 0)).toBe(4); // classified at the reported 0.1 mph
    expect(light(0, 1.0, 0)).toBe(3); // rain's is not
    expect(light(0, 1.01, 0)).toBe(4);
    expect(light(0, 0.0999, 0)).toBe(1); // reported as 0.100
    expect(light(0, 0, 3.0)).toBe(3);
    expect(light(0, 0, 3.001)).toBe(4);
    expect(light(30, 0.3, 1.2)).toBe(2); // the worst condition sets the level

    expect(classifier(RULES, 30_000)(45, 0, 0)).toBe(3);
    expect(classifier(RULES, 30_001)(45, 0, 0)).toBe(4);
    expect(classifier(RULES, 40_000)(35, 0, 0)).toBe(2);
    expect(classifier(RULES, 40_001)(35, 0, 0)).toBe(3);
    expect(classifier(RULES, 80_000)(34.9, 0, 0)).toBe(1);
  });
});

/** The risk level a painted pixel shows, read from its colour (its alpha also carries the corridor's edge). */
function levelOf([r, g, b]: (number | undefined)[]): number | "unpainted" {
  const level = RISK_RGBA.findIndex(([lr, lg, lb]) => lr === r && lg === g && lb === b);
  return level >= 0 ? level : "unpainted";
}

/** A 3 x 3 lattice, every cell inside, two hourly frames with the same value everywhere. */
function uniform(wind: [number, number], risk: [number, number] = [0, 0]): Corridor {
  const cells = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const frame = (v: number) => cells.map(() => v);
  return {
    bounds: [-100, 40, -99, 41],
    cols: 3,
    rows: 3,
    cells,
    half_width_km: 40,
    start: "2026-11-04T08:00-06:00",
    step_s: 3600,
    frames: 2,
    risk: [frame(risk[0]), frame(risk[1])],
    wind_mph: [frame(wind[0]), frame(wind[1])],
    rain_in_hr: [frame(0), frame(0)],
    snow_in_hr: [frame(0), frame(0)],
  };
}

const at = (target: Uint8ClampedArray, width: number, x: number, y: number) => {
  const q = (y * width + x) * 4;
  return [target[q], target[q + 1], target[q + 2], target[q + 3]];
};

describe("raster", () => {
  it("spreads each pixel over at most four cells with weights that sum to one", () => {
    const grid = raster(uniform([10, 10]));
    expect(grid.width).toBe(3 * SUPERSAMPLE);
    expect(grid.pixels.length).toBe(grid.width * grid.height);
    for (let p = 0; p < grid.pixels.length; p++) {
      const sum = [0, 1, 2, 3].reduce((s, i) => s + (grid.weights[p * 4 + i] ?? 0), 0);
      expect(sum).toBeCloseTo(1, 5);
      expect(grid.coverage[p]).toBeGreaterThan(0);
      expect(grid.coverage[p]).toBeLessThanOrEqual(1);
    }
  });

  it("puts one pixel exactly on every cell's centre, taking that cell's forecast alone", () => {
    const corridor = uniform([10, 10]);
    const grid = raster(corridor);
    const own = new Set<number>();
    for (let p = 0; p < grid.pixels.length; p++) {
      if (grid.weights[p * 4] === 1) own.add(grid.slots[p * 4] as number);
    }
    expect([...own].sort()).toEqual(corridor.cells.map((_, slot) => slot));
  });

  it("follows the routes' band, not the cells' staircase, when routes are given", () => {
    const plan = PLANS["chicago-atlanta"];
    if (!plan) throw new Error("fixture missing");
    const plain = raster(plan.corridor);
    const shaped = raster(
      plan.corridor,
      plan.routes.map((r) => decodePolyline(r.geometry)),
    );
    expect(shaped.pixels.length).toBeGreaterThan(plan.corridor.cells.length * SUPERSAMPLE ** 2 * 0.5);
    expect(shaped.pixels.length).toBeLessThanOrEqual(plain.pixels.length);
  });
});

describe("paint", () => {
  it("interpolates a continuous layer between hourly frames", () => {
    const corridor = uniform([40, 50]);
    const grid = raster(corridor);
    const target = new Uint8ClampedArray(grid.width * grid.height * 4);
    paint(corridor, grid, "wind", 0.5, target, null);
    const [r, g, b, a] = rampColor(RAMPS.wind, 45);
    expect(at(target, grid.width, 12, 12)).toEqual([r, g, b, Math.round(a * 255)]);
  });

  it("classifies the interpolated weather for the risk layer, with the load rules", () => {
    const corridor = uniform([40, 50]);
    const grid = raster(corridor);
    const target = new Uint8ClampedArray(grid.width * grid.height * 4);
    const heavy = classifier(RULES, 42_000);
    const color = (level: number) => {
      const [r, g, b, a] = RISK_RGBA[level] ?? [0, 0, 0, 0];
      return [r, g, b, Math.round(a * 255)];
    };
    paint(corridor, grid, "risk", 0, target, heavy);
    expect(at(target, grid.width, 12, 12)).toEqual(color(3)); // 40 mph, over 40,000 lb: High becomes Severe
    paint(corridor, grid, "risk", 0.5, target, heavy);
    expect(at(target, grid.width, 12, 12)).toEqual(color(4)); // 45 mph, over 30,000 lb: Severe becomes No Travel
  });

  it("falls back to the server's levels on the nearest hour before the rules arrive", () => {
    const corridor = uniform([0, 0], [1, 2]);
    const grid = raster(corridor);
    const target = new Uint8ClampedArray(grid.width * grid.height * 4);
    paint(corridor, grid, "risk", 0.4, target, null);
    expect(at(target, grid.width, 12, 12)[3]).toBe(Math.round((RISK_RGBA[1]?.[3] ?? 0) * 255));
    paint(corridor, grid, "risk", 0.6, target, null);
    expect(at(target, grid.width, 12, 12)[3]).toBe(Math.round((RISK_RGBA[2]?.[3] ?? 0) * 255));
  });

  it("shows an isolated cell's level, however close to the threshold", () => {
    const corridor = uniform([0, 0]);
    const wet = corridor.cells.map((_, slot) => (slot === 4 ? 0.105 : 0)); // the middle cell, just over Moderate
    corridor.rain_in_hr = [wet, wet];
    const grid = raster(corridor);
    const target = new Uint8ClampedArray(grid.width * grid.height * 4);
    paint(corridor, grid, "risk", 0, target, classifier(RULES, 0));
    const middle = Math.floor(1.5 * grid.scale);
    expect(levelOf(at(target, grid.width, middle, middle))).toBe(1);
  });

  it("leaves Low clear", () => {
    const corridor = uniform([5, 5]);
    const grid = raster(corridor);
    const target = new Uint8ClampedArray(grid.width * grid.height * 4);
    paint(corridor, grid, "risk", 0, target, classifier(RULES, 0));
    expect(target.every((v, i) => i % 4 !== 3 || v === 0)).toBe(true);
  });

  it("paints a real corridor fast enough to follow the slider", () => {
    const plan = PLANS["chicago-atlanta"];
    if (!plan) throw new Error("fixture missing");
    const grid = raster(
      plan.corridor,
      plan.routes.map((r) => decodePolyline(r.geometry)),
    );
    const target = new Uint8ClampedArray(grid.width * grid.height * 4);
    const classify = classifier(RULES, plan.request.load_lb);
    // Dragging the slider paints frame after frame, so what matters is the steady per-frame time: warm up first,
    // then time every frame and judge the median, which one slow frame on a busy machine does not move.
    for (let k = 0; k < 48; k++) paint(plan.corridor, grid, "risk", k, target, classify);
    const frames = 192;
    const times: number[] = [];
    for (let k = 0; k < frames; k++) {
      const start = performance.now();
      paint(plan.corridor, grid, "risk", (k * 48) / frames, target, classify);
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const median = times[frames / 2] as number;
    expect(median).toBeLessThan(12); // a 60 Hz frame is 16.7 ms
  });
});
