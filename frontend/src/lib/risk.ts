import type { Level, Miles } from "../api/schema";
import { LEVELS } from "../api/schema";

export const LEVEL_LABEL: Record<Level, string> = {
  low: "Low",
  moderate: "Moderate",
  high: "High",
  severe: "Severe",
  no_travel: "No Travel",
};

export const LEVEL_SHORT: Record<Level, string> = {
  low: "LOW",
  moderate: "MOD",
  high: "HIGH",
  severe: "SEV",
  no_travel: "NO TRAVEL",
};

/** The only colour in the interface: one per level, readable on the near-black ground. */
export const LEVEL_COLOR: Record<Level, string> = {
  low: "#4ade80",
  moderate: "#facc15",
  high: "#fb923c",
  severe: "#ef4444",
  no_travel: "#e040fb",
};

export const levelIndex = (level: Level): number => LEVELS.indexOf(level);
export const levelAt = (index: number): Level => LEVELS[Math.min(Math.max(Math.round(index), 0), 4)] as Level;

export function totalMiles(miles: Miles): number {
  return LEVELS.reduce((sum, level) => sum + miles[level], 0);
}

export const CAUSE_LABEL: Record<string, string> = { wind: "wind", rain: "rain", snow: "snow" };

/**
 * How many decimals wind, rain and snow are classified at (`decimals` in /api/rules), so they are shown at it: the
 * server's own values, for the moment before the rules arrive.
 */
export type Decimals = { wind: number; rain: number; snow: number };
export const DECIMALS: Decimals = { wind: 1, rain: 3, snow: 3 };

export const LOAD_RULE_TEXT: Record<string, string> = {
  wind_45_over_30000_lb: "45–54 mph with more than 30,000 lb aboard: No Travel",
  wind_35_over_40000_lb: "35–44 mph with more than 40,000 lb aboard: Severe",
};
