"""The planning pipeline.

routes -> checkpoints and arrival times -> forecasts at those times -> risk -> ranking -> corridor heatmap.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
from django.conf import settings

from . import checkpoints, corridor, routing, scoring, weather
from .geo import encode_polyline, points_at, simplify
from .geocoding import time_zone
from .http import cache_key, cached
from .risk import RAIN, SNOW, WIND, Assessment, Risk, assess, half_up, half_up_array
from .schedule import FMCSA, HoursOfService, elapsed_s, stops, timeline
from .schemas import PlanIn

ROUTE_CACHE_S = 6 * 3600
MIN_CORRIDOR_CELLS = 120
MAX_CORRIDOR_CELLS = 200
ATTRIBUTION = {
    "tomtom": "Routing © TomTom",
    "valhalla": "Routing: Valhalla on FOSSGIS servers, © OpenStreetMap contributors",
    "osrm": "Routing: OSRM demo server, © OpenStreetMap contributors",
}


@dataclass
class PlanError(Exception):
    code: str
    message: str
    status: int = 422


def resolve_departure(text: str, tz_name: str, now: datetime) -> datetime:
    """An aware departure time: an ISO time with an offset as given, a naive one as local time at the origin."""
    try:
        when = datetime.fromisoformat(text.strip())
    except ValueError as exc:
        raise PlanError("invalid_departure", "Departure must look like 2026-11-04T08:00.") from exc
    if when.tzinfo is None:
        when = when.replace(tzinfo=ZoneInfo(tz_name))
    if when < now - timedelta(hours=1):
        raise PlanError("departure_in_past", "Departure is in the past.")
    if when > now + timedelta(days=settings.DEPARTURE_MAX_DAYS_AHEAD):
        raise PlanError(
            "departure_too_far",
            f"Departure must be within {settings.DEPARTURE_MAX_DAYS_AHEAD} days: forecasts beyond that are not "
            "reliable enough to rank routes.",
        )
    return when


def plan(payload: PlanIn, now: datetime | None = None) -> dict:
    timings: dict[str, float] = {}
    clock = time.perf_counter()
    now = now or datetime.now(UTC)
    origin = routing.Place(payload.origin.lat, payload.origin.lon)
    destination = routing.Place(payload.destination.lat, payload.destination.lon)
    if abs(origin.lat - destination.lat) < 1e-4 and abs(origin.lon - destination.lon) < 1e-4:
        raise PlanError("same_place", "Origin and destination are the same place.")
    tz_name = time_zone(origin.lat, origin.lon)
    zone = ZoneInfo(tz_name)
    departure = resolve_departure(payload.departure, tz_name, now)
    truck = routing.Truck(load_lb=payload.load_lb)
    hos = FMCSA if payload.hours_of_service else None

    key = cache_key(
        "routes",
        round(origin.lat, 4),
        round(origin.lon, 4),
        round(destination.lat, 4),
        round(destination.lon, 4),
        round(payload.load_lb, -3),
        departure.astimezone(UTC).strftime("%Y-%m-%dT%H"),
        settings.ROUTING_PROVIDERS,
        bool(settings.TOMTOM_API_KEY),
    )
    routes, routes_cached = cached(
        key, ROUTE_CACHE_S, lambda: routing.find_routes(origin, destination, truck, departure)
    )
    if not routes:
        raise PlanError("no_route", "No truck route was found between these places.")
    timings["routing"] = _ms(clock)

    # Checkpoints and when the truck reaches them.
    clock = time.perf_counter()
    placed = [checkpoints.place(r.points, r.cum_mi, r.cum_drive_s, payload.interval_mi, hos) for r in routes]
    etas = [[departure + timedelta(seconds=c.elapsed_s) for c in cps] for cps in placed]
    leads = [[weather.lead_hours(t, now) for t in route_etas] for route_etas in etas]
    flat = [
        (c.lat, c.lon, lead) for cps, ls in zip(placed, leads, strict=True) for c, lead in zip(cps, ls, strict=True)
    ]
    budget = settings.WEATHER_LOCATION_BUDGET
    sampling = weather.plan_locations(flat, budget - MIN_CORRIDOR_CELLS)
    cells = min(max(budget - len(sampling.locations), MIN_CORRIDOR_CELLS), MAX_CORRIDOR_CELLS)
    lattice = corridor.build([(r.points, r.cum_mi) for r in routes], cells)
    locations = sampling.locations + [
        weather.Location(round(float(a), 4), round(float(b), 4)) for a, b in zip(lattice.lat, lattice.lon, strict=True)
    ]
    timings["sampling"] = _ms(clock)

    clock = time.perf_counter()
    supplied = None
    if payload.weather is not None:
        try:
            supplied = weather.supplied_series(payload.weather.locations, payload.weather.response)
        except ValueError as exc:
            raise PlanError("invalid_weather", f"The supplied forecast cannot be used: {exc}.") from exc
    last_eta = max(route_etas[-1] for route_etas in etas)
    forecasts, wx = weather.fetch(locations, departure, max(last_eta, departure + timedelta(hours=48)), supplied)
    timings["weather"] = _ms(clock)

    clock = time.perf_counter()
    out_routes: list[dict[str, Any]] = []
    scores: list[scoring.Score] = []
    offset = 0
    names = routing.route_names(routes)
    for i, (route, cps, route_etas, route_leads) in enumerate(zip(routes, placed, etas, leads, strict=True)):
        index = sampling.index[offset : offset + len(cps)]
        offset += len(cps)
        at = forecasts.at(index, [t.timestamp() for t in route_etas])
        rain = at["rain"] + at["showers"]
        assessed = [
            assess(float(w), float(r), float(s), payload.load_lb)
            for w, r, s in zip(at["wind_speed_10m"], rain, at["snowfall"], strict=True)
        ]
        levels = [a.level for a in assessed]
        exposure = scoring.exposure(levels, [c.represents_mi for c in cps])
        trip_s = float(elapsed_s(route.drive_s, hos))
        route_id = "ABC"[i]
        scores.append(scoring.Score(route_id=route_id, exposure=exposure, trip_time_s=trip_s))
        out_routes.append(
            {
                "id": route_id,
                "name": names[i],
                "provider": route.provider,
                "distance_mi": round(route.distance_mi, 1),
                "drive_s": round(route.drive_s),
                "trip_s": round(trip_s),
                "traffic_delay_s": round(route.traffic_delay_s),
                "departure": _iso(departure, zone),
                "arrival": _iso(departure + timedelta(seconds=trip_s), zone),
                "geometry": encode_polyline(simplify(route.points)),
                "miles": {level.key: round(exposure.at(level), 1) for level in Risk},
                "average_risk": round(exposure.average, 2),
                "worst": max(levels).key,
                "checkpoints": [
                    {
                        "mile": round(c.mile, 2),
                        "lat": round(c.lat, 5),
                        "lon": round(c.lon, 5),
                        "eta": _iso(t, zone),
                        "drive_s": round(c.drive_s),
                        "represents_mi": round(c.represents_mi, 2),
                        "lead_h": round(lead, 1),
                        "time_zone": time_zone(c.lat, c.lon),
                        # Wind, rain and snow at the precision, and with the rounding, they are classified at.
                        "weather": {
                            "wind_mph": half_up(float(at["wind_speed_10m"][k]), WIND.decimals),
                            "gust_mph": round(float(at["wind_gusts_10m"][k]), 1),
                            "rain_in_hr": half_up(float(rain[k]), RAIN.decimals),
                            "snow_in_hr": half_up(float(at["snowfall"][k]), SNOW.decimals),
                            "temp_f": round(float(at["temperature_2m"][k]), 1),
                            "code": int(at["weather_code"][k]),
                        },
                        "risk": {
                            "level": a.level.key,
                            "wind": a.wind.key,
                            "rain": a.rain.key,
                            "snow": a.snow.key,
                            "load_rule": a.load_rule.code if a.load_rule else None,
                            "causes": list(a.causes),
                        },
                    }
                    for k, (c, t, lead, a) in enumerate(zip(cps, route_etas, route_leads, assessed, strict=True))
                ],
                "stops": _stops(route, departure, zone, hos),
                "hazards": _hazards(cps, route_etas, assessed, route.distance_mi, zone),
                "timeline": [list(p) for p in timeline(route.cum_mi, route.cum_drive_s, hos)],
            }
        )

    ranked = scoring.rank(scores)
    best = ranked[0]
    position = {s.route_id: n for n, s in enumerate(ranked, start=1)}
    for r in out_routes:
        r["rank"] = position[r["id"]]
        r["recommended"] = r["id"] == best.route_id
    out_routes.sort(key=lambda r: r["rank"])
    comparisons = [scoring.compare(best, other) for other in ranked[1:]]

    frames = corridor.frames(
        forecasts, range(len(sampling.locations), len(locations)), departure.timestamp(), payload.load_lb
    )
    timings["scoring"] = _ms(clock)

    return {
        "request": {
            "origin": payload.origin.model_dump(),
            "destination": payload.destination.model_dump(),
            "departure": _iso(departure, zone),
            "time_zone": tz_name,
            "load_lb": payload.load_lb,
            "gross_lb": truck.tare_lb + payload.load_lb,
            "interval_mi": payload.interval_mi,
            "hours_of_service": payload.hours_of_service,
        },
        "routes": out_routes,
        "recommendation": {
            "route_id": best.route_id,
            "no_safe_route": best.exposure.at(Risk.NO_TRAVEL) > 0,
            "comparisons": [_comparison(c) for c in comparisons],
        },
        "corridor": {
            "bounds": [round(v, 6) for v in lattice.bounds()],
            "cols": lattice.cols,
            "rows": lattice.rows,
            "cells": lattice.cells.tolist(),
            "half_width_km": round(lattice.half_width_km, 1),
            "start": _iso(departure, zone),
            "step_s": 3600,
            "frames": corridor.FRAMES,
            "risk": frames.risk.astype(int).tolist(),
            "wind_mph": half_up_array(frames.wind_mph, WIND.decimals).tolist(),
            "rain_in_hr": half_up_array(frames.rain_in_hr, RAIN.decimals).tolist(),
            "snow_in_hr": half_up_array(frames.snow_in_hr, SNOW.decimals).tolist(),
        },
        "meta": {
            "routing_provider": routes[0].provider,
            "weather_locations": wx["locations"],
            "weather_downloaded": wx["downloaded"],
            "weather_cached": wx["cached"],
            "weather_supplied": wx["supplied"],
            "weather_snapped": sampling.snapped,
            "weather_grid_deg": sampling.grid_deg,
            "cached_routes": routes_cached,
            "timings_ms": timings,
            "attribution": [
                ATTRIBUTION.get(routes[0].provider, "Routing"),
                "Weather data by Open-Meteo.com (CC BY 4.0)",
                "Map data © OpenStreetMap contributors, OpenFreeMap",
            ],
        },
    }


def _comparison(c: scoring.Comparison) -> dict:
    return {"route_id": c.route_id, "key": c.key, "best": c.best, "other": c.other}


def _stops(route: routing.Route, departure: datetime, zone: ZoneInfo, hos: HoursOfService | None) -> list[dict]:
    out = []
    for stop in stops(route.drive_s, hos):
        mile = float(np.interp(stop.drive_s, route.cum_drive_s, route.cum_mi))
        lat, lon = points_at(route.points, route.cum_mi, [mile])[0]
        out.append(
            {
                "kind": stop.kind,
                "mile": round(mile, 1),
                "lat": round(float(lat), 5),
                "lon": round(float(lon), 5),
                "start": _iso(departure + timedelta(seconds=stop.start_s), zone),
                "end": _iso(departure + timedelta(seconds=stop.end_s), zone),
            }
        )
    return out


def _hazards(
    cps: list[checkpoints.Checkpoint],
    etas: list[datetime],
    assessed: list[Assessment],
    length_mi: float,
    zone: ZoneInfo,
) -> list[dict]:
    runs = scoring.hazards([a.level for a in assessed], [a.causes for a in assessed])
    miles = [c.mile for c in cps]
    out = []
    for h in runs:
        start = (miles[h.first - 1] + miles[h.first]) / 2 if h.first > 0 else 0.0
        end = (miles[h.last] + miles[h.last + 1]) / 2 if h.last + 1 < len(miles) else length_mi
        out.append(
            {
                "level": h.level.key,
                "from_mile": round(start, 1),
                "to_mile": round(end, 1),
                "from_eta": _iso(etas[h.first], zone),
                "to_eta": _iso(etas[h.last], zone),
                "causes": list(h.causes),
            }
        )
    return out


def _iso(when: datetime, zone: ZoneInfo) -> str:
    return when.astimezone(zone).isoformat(timespec="minutes")


def _ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 1)
