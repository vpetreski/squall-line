import { describe, expect, it } from "vitest";
import type { Level, Route } from "../api/schema";
import { Line } from "../lib/geo";
import { LEVEL_COLOR } from "../lib/risk";
import { PLANS } from "../test/fixtures";
import { routeGradient } from "./gradient";

const base = PLANS["chicago-atlanta"]?.routes[0];
if (!base) throw new Error("fixture missing");

/** A route due north from 30° N to 50° N with a checkpoint every tenth of its length at the given levels. */
function northbound(levels: Level[]): { route: Route; line: Line } {
  const line = new Line(Array.from({ length: 81 }, (_, i): [number, number] => [30 + i / 4, -90]));
  const template = base?.checkpoints[0];
  if (!template) throw new Error("fixture has no checkpoints");
  const checkpoints = levels.map((level, i) => ({
    ...template,
    mile: (line.length * i) / (levels.length - 1),
    risk: { ...template.risk, level },
  }));
  return { route: { ...(base as Route), distance_mi: line.length, checkpoints }, line };
}

describe("route gradient", () => {
  it("changes colour halfway between two checkpoints, on the map's own measure of the line", () => {
    const levels: Level[] = [
      "low",
      "low",
      "low",
      "low",
      "low",
      "low",
      "severe",
      "severe",
      "severe",
      "severe",
      "severe",
    ];
    const { route, line } = northbound(levels);
    const expression = routeGradient(route, line);
    // Halfway between the checkpoints at 50% and 60% of the miles.
    expect(expression).toEqual(["step", ["line-progress"], LEVEL_COLOR.low, line.progress(0.55), LEVEL_COLOR.severe]);
    expect(Math.abs(line.progress(0.55) - 0.55)).toBeGreaterThan(0.01); // the miles alone would put it elsewhere
  });

  it("is one colour when the level never changes", () => {
    const { route, line } = northbound(["moderate", "moderate", "moderate"]);
    expect(routeGradient(route, line)).toEqual([
      "interpolate",
      ["linear"],
      ["line-progress"],
      0,
      LEVEL_COLOR.moderate,
      1,
      LEVEL_COLOR.moderate,
    ]);
  });
});
