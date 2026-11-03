/**
 * The API contract, checked at runtime. These mirror backend/planner/schemas.py; a response that does not fit
 * fails loudly here instead of half-rendering.
 */
import { z } from "zod";

export const LEVELS = ["low", "moderate", "high", "severe", "no_travel"] as const;
export const Level = z.enum(LEVELS);
export type Level = z.infer<typeof Level>;

const Point = z.object({ lat: z.number(), lon: z.number(), label: z.string() });

export const Suggestion = z.object({
  label: z.string(),
  detail: z.string(),
  lat: z.number(),
  lon: z.number(),
  kind: z.string(),
  time_zone: z.string(),
});
export type Suggestion = z.infer<typeof Suggestion>;
export const GeocodeOut = z.object({ results: z.array(Suggestion) });

const Weather = z.object({
  wind_mph: z.number(),
  gust_mph: z.number(),
  rain_in_hr: z.number(),
  snow_in_hr: z.number(),
  temp_f: z.number(),
  code: z.number(),
});

const Assessment = z.object({
  level: Level,
  wind: Level,
  rain: Level,
  snow: Level,
  load_rule: z.string().nullable(),
  causes: z.array(z.string()),
});

export const Checkpoint = z.object({
  mile: z.number(),
  lat: z.number(),
  lon: z.number(),
  eta: z.string(),
  drive_s: z.number(),
  represents_mi: z.number(),
  lead_h: z.number(),
  time_zone: z.string(),
  weather: Weather,
  risk: Assessment,
});
export type Checkpoint = z.infer<typeof Checkpoint>;

const Stop = z.object({
  kind: z.enum(["break", "rest"]),
  mile: z.number(),
  lat: z.number(),
  lon: z.number(),
  start: z.string(),
  end: z.string(),
});
export type Stop = z.infer<typeof Stop>;

const Hazard = z.object({
  level: Level,
  from_mile: z.number(),
  to_mile: z.number(),
  from_eta: z.string(),
  to_eta: z.string(),
  causes: z.array(z.string()),
});
export type Hazard = z.infer<typeof Hazard>;

const Miles = z.object({
  low: z.number(),
  moderate: z.number(),
  high: z.number(),
  severe: z.number(),
  no_travel: z.number(),
});
export type Miles = z.infer<typeof Miles>;

export const Route = z.object({
  id: z.string(),
  name: z.string(),
  rank: z.number(),
  recommended: z.boolean(),
  provider: z.string(),
  distance_mi: z.number(),
  drive_s: z.number(),
  trip_s: z.number(),
  traffic_delay_s: z.number(),
  departure: z.string(),
  arrival: z.string(),
  geometry: z.string(),
  miles: Miles,
  average_risk: z.number(),
  worst: Level,
  checkpoints: z.array(Checkpoint),
  stops: z.array(Stop),
  hazards: z.array(Hazard),
  timeline: z.array(z.tuple([z.number(), z.number()])),
});
export type Route = z.infer<typeof Route>;

export const RANKING_KEYS = ["no_travel_miles", "severe_miles", "high_miles", "average_risk", "trip_time_s"] as const;

const Comparison = z.object({
  route_id: z.string(),
  key: z.enum(RANKING_KEYS).nullable(),
  best: z.number().nullable(),
  other: z.number().nullable(),
});
export type Comparison = z.infer<typeof Comparison>;

const Corridor = z.object({
  bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  cells: z.array(z.number().int().nonnegative()),
  half_width_km: z.number(),
  start: z.string(),
  step_s: z.number(),
  frames: z.number().int().positive(),
  risk: z.array(z.array(z.number())),
  wind_mph: z.array(z.array(z.number())),
  rain_in_hr: z.array(z.array(z.number())),
  snow_in_hr: z.array(z.array(z.number())),
});
export type Corridor = z.infer<typeof Corridor>;

export const Plan = z.object({
  request: z.object({
    origin: Point,
    destination: Point,
    departure: z.string(),
    time_zone: z.string(),
    load_lb: z.number(),
    gross_lb: z.number(),
    interval_mi: z.number(),
    hours_of_service: z.boolean(),
  }),
  routes: z.array(Route).min(1),
  recommendation: z.object({ route_id: z.string(), no_safe_route: z.boolean(), comparisons: z.array(Comparison) }),
  corridor: Corridor,
  meta: z.object({
    routing_provider: z.string(),
    weather_locations: z.number(),
    weather_downloaded: z.number(),
    weather_cached: z.number(),
    weather_supplied: z.number(),
    weather_snapped: z.number(),
    weather_grid_deg: z.tuple([z.number(), z.number()]),
    cached_routes: z.boolean(),
    timings_ms: z.record(z.string(), z.number()),
    attribution: z.array(z.string()),
  }),
});
export type Plan = z.infer<typeof Plan>;

const Scale = z.object({
  unit: z.string(),
  moderate: z.number(),
  high: z.number(),
  severe: z.number(),
  no_travel: z.number(),
  no_travel_inclusive: z.boolean(),
  decimals: z.number(),
});
export type Scale = z.infer<typeof Scale>;

export const Rules = z.object({
  levels: z.array(Level),
  wind: Scale,
  rain: Scale,
  snow: Scale,
  load_rules: z.array(z.object({ code: z.string(), level: Level, over_lb: z.number(), raised_to: Level })),
});
export type Rules = z.infer<typeof Rules>;

export const Relay = z.object({
  url: z.string().url(),
  form: z.record(z.string(), z.string()),
  locations: z.array(z.tuple([z.number(), z.number()])),
});
export type Relay = z.infer<typeof Relay>;

export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).nullish(),
    relay: Relay.nullish(),
  }),
});

export type PlanInput = {
  origin: { lat: number; lon: number; label: string };
  destination: { lat: number; lon: number; label: string };
  departure: string;
  load_lb: number;
  interval_mi: 10 | 25 | 50;
  hours_of_service: boolean;
};
