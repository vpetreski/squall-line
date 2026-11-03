import { type Checkpoint, LEVELS, type Plan } from "../api/schema";
import { classifier } from "../lib/heatmap";
import { PLANS, RULES } from "./fixtures";

/**
 * The stormy fixture with the recommended route's first checkpoint at the given weather, and the level the published
 * rules give it, so a test can check that the numbers shown explain the level shown.
 */
export function planWithWeather(weather: Partial<Checkpoint["weather"]>): { plan: Plan; checkpoint: Checkpoint } {
  const base = PLANS["chicago-atlanta"];
  if (!base) throw new Error("fixture missing");
  const plan = structuredClone(base);
  const route = plan.routes.find((r) => r.id === plan.recommendation.route_id);
  const checkpoint = route?.checkpoints[0];
  if (!checkpoint) throw new Error("fixture has no checkpoints");
  checkpoint.weather = { ...checkpoint.weather, wind_mph: 0, rain_in_hr: 0, snow_in_hr: 0, ...weather };
  const level = (w: number, r: number, s: number) => LEVELS[classifier(RULES, 0)(w, r, s)] ?? "low";
  const { wind_mph, rain_in_hr, snow_in_hr } = checkpoint.weather;
  checkpoint.risk = {
    level: level(wind_mph, rain_in_hr, snow_in_hr),
    wind: level(wind_mph, 0, 0),
    rain: level(0, rain_in_hr, 0),
    snow: level(0, 0, snow_in_hr),
    load_rule: null,
    causes: [],
  };
  return { plan, checkpoint };
}
