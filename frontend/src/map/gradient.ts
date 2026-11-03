import type { ExpressionSpecification } from "maplibre-gl";
import type { Route } from "../api/schema";
import type { Line } from "../lib/geo";
import { LEVEL_COLOR } from "../lib/risk";

/**
 * Colour along the route by the level of the checkpoint that stands for each stretch: the colour changes halfway
 * between two checkpoints of different levels. The stops are placed by miles and converted to the projected length
 * that MapLibre's `line-progress` measures, so each change lands on its mile.
 */
export function routeGradient(route: Route, line: Line): ExpressionSpecification {
  const cps = route.checkpoints;
  const first = cps[0];
  if (!first) return ["interpolate", ["linear"], ["line-progress"], 0, LEVEL_COLOR.low, 1, LEVEL_COLOR.low];
  const length = route.distance_mi || 1;
  const stops: (number | string)[] = [];
  let current = first.risk.level;
  let previous = 0;
  for (let i = 1; i < cps.length; i++) {
    const here = cps[i];
    const before = cps[i - 1];
    if (!here || !before || here.risk.level === current) continue;
    const at = Math.min(Math.max(line.progress((before.mile + here.mile) / 2 / length), previous + 1e-6), 1);
    stops.push(at, LEVEL_COLOR[here.risk.level]);
    current = here.risk.level;
    previous = at;
  }
  const base = LEVEL_COLOR[first.risk.level];
  if (stops.length === 0) return ["interpolate", ["linear"], ["line-progress"], 0, base, 1, base];
  return ["step", ["line-progress"], base, ...stops] as ExpressionSpecification;
}
