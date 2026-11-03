"""Three route options for a truck, from a routing engine.

TomTom's truck routing is the primary engine: it honours truck restrictions and the truck's weight and governed
speed, and returns up to two alternatives for trips of any length. Without a TomTom key the keyless public servers
are used: Valhalla's truck costing for trips it accepts (its public server refuses more than 1,500 km of straight
line), otherwise OSRM, whose car times are capped at the truck's governed speed.

An engine's own alternatives are kept unless one shares 97% or more of its road with a faster one. When fewer than
three remain, more candidates come from routing through a point to one side of the main route's midpoint, then
from the far side, keeping only those that share less than 80% of their road with the routes already chosen and
take at most 1.5 times as long.
"""

from __future__ import annotations

import itertools
import logging
import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import numpy as np
import numpy.typing as npt
from django.conf import settings

from .geo import METERS_PER_MILE, cumulative_miles, decode_polyline, haversine_mi, points_at
from .http import Pace, UpstreamError, request
from .schedule import drive_profile

log = logging.getLogger(__name__)
FloatArray = npt.NDArray[np.float64]

LB_PER_KG = 2.20462262
MPH_PER_KMH = 0.621371192
VALHALLA_MAX_STRAIGHT_MI = 900.0
DISTINCT_OVERLAP = 0.8
DUPLICATE_OVERLAP = 0.97
MAX_DETOUR_FACTOR = 1.5


@dataclass(frozen=True, slots=True)
class Place:
    lat: float
    lon: float


@dataclass(frozen=True, slots=True)
class Truck:
    """A Class 8 tractor with a 53-ft trailer; tare weight is a typical tractor plus dry van."""

    load_lb: float
    tare_lb: float = 35_000
    max_speed_kmh: int = 105  # 65 mph, the most common governor setting
    length_m: float = 21.9
    width_m: float = 2.6
    height_m: float = 4.11

    @property
    def gross_kg(self) -> int:
        return round((self.tare_lb + self.load_lb) / LB_PER_KG)

    @property
    def max_speed_mps(self) -> float:
        return self.max_speed_kmh / 3.6


@dataclass(slots=True)
class Route:
    points: FloatArray  # (n, 2) lat, lon
    cum_mi: FloatArray  # miles from the origin at each point
    cum_drive_s: FloatArray  # seconds of driving from the origin at each point
    roads: dict[str, float] = field(default_factory=dict)  # road number -> miles on it
    provider: str = ""
    traffic_delay_s: float = 0.0

    @property
    def distance_mi(self) -> float:
        return float(self.cum_mi[-1])

    @property
    def drive_s(self) -> float:
        return float(self.cum_drive_s[-1])

    def name(self, parts: int = 2) -> str:
        top = sorted(self.roads.items(), key=lambda kv: -kv[1])[:parts]
        return " · ".join(road for road, _ in top) or "Local roads"


def _scaled(points: FloatArray, total_mi: float) -> FloatArray:
    """Cumulative miles along the polyline, rescaled to the engine's own route length."""
    cum = cumulative_miles(points)
    return cum * (total_mi / cum[-1]) if cum[-1] > 0 and total_mi > 0 else cum


def _road(number: str) -> str:
    """'I-80 W' -> 'I-80', 'US-30 E' -> 'US-30'."""
    parts = number.split()
    return parts[0] if parts else number


class TomTom:
    name = "tomtom"
    url = "https://api.tomtom.com/routing/1/calculateRoute/{locations}/json"

    def __init__(self, key: str) -> None:
        self.key = key

    def routes(self, origin: Place, destination: Place, truck: Truck, departure: datetime) -> list[Route]:
        locations = f"{origin.lat:.6f},{origin.lon:.6f}:{destination.lat:.6f},{destination.lon:.6f}"
        params: dict[str, str | int | float] = {
            "key": self.key,
            "travelMode": "truck",
            "routeType": "fastest",
            "maxAlternatives": 2,
            "traffic": "true",
            "departAt": _depart_at(departure),
            "vehicleWeight": truck.gross_kg,
            "vehicleMaxSpeed": truck.max_speed_kmh,
            "vehicleCommercial": "true",
            "vehicleLength": truck.length_m,
            "vehicleWidth": truck.width_m,
            "vehicleHeight": truck.height_m,
            "routeRepresentation": "polyline",
            "instructionsType": "coded",
        }
        response = request("routing", "GET", self.url.format(locations=locations), params=params)
        body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
        if response.status_code == 400 and "NO_ROUTE_FOUND" in str(body):
            return []
        if response.status_code != 200:
            message = (body.get("detailedError") or {}).get("message", f"HTTP {response.status_code}")
            raise UpstreamError("routing", f"TomTom: {message}", response.status_code)
        return [self._route(r) for r in body.get("routes", [])]

    def _route(self, data: dict) -> Route:
        points = np.array([[p["latitude"], p["longitude"]] for leg in data["legs"] for p in leg["points"]])
        summary = data["summary"]
        cum_mi = _scaled(points, summary["lengthInMeters"] / METERS_PER_MILE)
        instructions = sorted(data.get("guidance", {}).get("instructions", []), key=lambda i: i["pointIndex"])
        index = [0, *(i["pointIndex"] for i in instructions), len(points) - 1]
        total_s = float(summary["travelTimeInSeconds"])
        seconds = [0.0, *(float(i["travelTimeInSeconds"]) for i in instructions), total_s]
        roads: dict[str, float] = {}
        for here, after in itertools.pairwise(instructions):
            numbers = here.get("roadNumbers") or []
            if numbers:
                miles = (after["routeOffsetInMeters"] - here["routeOffsetInMeters"]) / METERS_PER_MILE
                roads[_road(numbers[0])] = roads.get(_road(numbers[0]), 0.0) + miles
        return Route(
            points=points,
            cum_mi=cum_mi,
            cum_drive_s=drive_profile(cum_mi, index, seconds),
            roads=roads,
            provider=self.name,
            traffic_delay_s=float(summary.get("trafficDelayInSeconds", 0)),
        )

    def via(self, origin: Place, via: Place, destination: Place, truck: Truck, departure: datetime) -> Route | None:
        locations = ":".join(f"{p.lat:.6f},{p.lon:.6f}" for p in (origin, via, destination))
        params: dict[str, str | int | float] = {
            "key": self.key,
            "travelMode": "truck",
            "routeType": "fastest",
            "traffic": "true",
            "departAt": _depart_at(departure),
            "vehicleWeight": truck.gross_kg,
            "vehicleMaxSpeed": truck.max_speed_kmh,
            "vehicleCommercial": "true",
            "routeRepresentation": "polyline",
            "instructionsType": "coded",
        }
        response = request("routing", "GET", self.url.format(locations=locations), params=params)
        if response.status_code != 200:
            return None
        routes = response.json().get("routes", [])
        return self._route(routes[0]) if routes else None


def _depart_at(departure: datetime) -> str:
    """TomTom wants a future time; anything within the next minute is 'now'."""
    if departure <= datetime.now(UTC) + timedelta(minutes=1):
        return "now"
    return departure.isoformat(timespec="seconds")


def _fit(profile: FloatArray, total_s: float) -> FloatArray:
    """Scale a drive-time profile so it ends exactly at the engine's trip time."""
    return profile * (total_s / profile[-1]) if profile[-1] > 0 else profile


class Valhalla:
    name = "valhalla"
    pace = Pace(1.05)

    def routes(self, origin: Place, destination: Place, truck: Truck, departure: datetime) -> list[Route]:
        if float(haversine_mi(origin.lat, origin.lon, destination.lat, destination.lon)) > VALHALLA_MAX_STRAIGHT_MI:
            return []
        body = self._body([origin, destination], truck) | {"alternates": 2}
        data = self._post(body)
        trips = [data["trip"]] + [alt["trip"] for alt in data.get("alternates", [])]
        return [self._route(t) for t in trips]

    def via(self, origin: Place, via: Place, destination: Place, truck: Truck, departure: datetime) -> Route | None:
        try:
            data = self._post(self._body([origin, via, destination], truck))
        except UpstreamError:
            return None
        return self._route(data["trip"])

    def _body(self, places: Sequence[Place], truck: Truck) -> dict:
        locations = [{"lat": p.lat, "lon": p.lon, "type": "break"} for p in places]
        for loc in locations[1:-1]:
            loc["type"] = "through"
        return {
            "locations": locations,
            "costing": "truck",
            "costing_options": {
                "truck": {
                    "weight": round(truck.gross_kg / 1000, 2),
                    "top_speed": truck.max_speed_kmh,
                    "length": truck.length_m,
                    "width": truck.width_m,
                    "height": truck.height_m,
                }
            },
            "units": "miles",
            "language": "en-US",
        }

    def _post(self, body: dict) -> dict:
        response = request("routing", "POST", f"{settings.VALHALLA_URL}/route", json=body, pace=self.pace)
        data = response.json() if response.content else {}
        if response.status_code != 200:
            raise UpstreamError("routing", f"Valhalla: {data.get('error', response.status_code)}", response.status_code)
        return data

    def _route(self, trip: dict) -> Route:
        shape: list[FloatArray] = []
        index: list[int] = [0]
        seconds: list[float] = [0.0]
        roads: dict[str, float] = {}
        offset = 0
        for leg in trip["legs"]:
            pts = decode_polyline(leg["shape"])
            if shape:
                pts = pts[1:]  # legs share their joining point
                offset -= 1
            for m in leg["maneuvers"]:
                index.append(m["end_shape_index"] + offset)
                seconds.append(seconds[-1] + float(m["time"]))
                names = [n for n in m.get("street_names", []) if any(ch.isdigit() for ch in n)]
                if names:
                    road = _road(names[0].replace(" ", "-", 1))
                    roads[road] = roads.get(road, 0.0) + m["length"]
            offset += len(pts)
            shape.append(pts)
        points = np.vstack(shape)
        cum_mi = _scaled(points, trip["summary"]["length"])
        return Route(
            points=points,
            cum_mi=cum_mi,
            cum_drive_s=_fit(drive_profile(cum_mi, index, seconds), trip["summary"]["time"]),
            roads=roads,
            provider=self.name,
        )


class OSRM:
    """Car routing on the public OSRM server; each segment is slowed to the truck's governed speed."""

    name = "osrm"
    pace = Pace(1.05)

    def routes(self, origin: Place, destination: Place, truck: Truck, departure: datetime) -> list[Route]:
        data = self._get([origin, destination], {"alternatives": "3"})
        return [self._route(r, truck) for r in data.get("routes", [])]

    def via(self, origin: Place, via: Place, destination: Place, truck: Truck, departure: datetime) -> Route | None:
        try:
            data = self._get([origin, via, destination], {})
        except UpstreamError:
            return None
        routes = data.get("routes", [])
        return self._route(routes[0], truck) if routes else None

    def _get(self, places: Sequence[Place], extra: dict[str, str]) -> dict:
        coords = ";".join(f"{p.lon:.6f},{p.lat:.6f}" for p in places)
        params = {"overview": "full", "geometries": "polyline6", "annotations": "duration,distance", "steps": "true"}
        response = request(
            "routing", "GET", f"{settings.OSRM_URL}/route/v1/driving/{coords}", params=params | extra, pace=self.pace
        )
        data = response.json() if response.content else {}
        if response.status_code == 400 and data.get("code") == "NoRoute":
            return {"routes": []}
        if response.status_code != 200:
            raise UpstreamError("routing", f"OSRM: {data.get('message', response.status_code)}", response.status_code)
        return data

    def _route(self, data: dict, truck: Truck) -> Route:
        points = decode_polyline(data["geometry"])
        seconds = np.concatenate([leg["annotation"]["duration"] for leg in data["legs"]])
        meters = np.concatenate([leg["annotation"]["distance"] for leg in data["legs"]])
        seconds = np.maximum(seconds, meters / truck.max_speed_mps)
        n = min(len(points) - 1, len(seconds))
        cum_drive = np.concatenate([[0.0], np.cumsum(seconds[:n])])
        points = points[: n + 1]
        roads: dict[str, float] = {}
        for leg in data["legs"]:
            for step in leg.get("steps", []):
                ref = (step.get("ref") or "").split(";")[0].strip()
                if ref:
                    road = _road(ref.replace(" ", "-", 1))
                    roads[road] = roads.get(road, 0.0) + step["distance"] / METERS_PER_MILE
        return Route(
            points=points,
            cum_mi=_scaled(points, data["distance"] / METERS_PER_MILE),
            cum_drive_s=cum_drive,
            roads=roads,
            provider=self.name,
        )


def providers() -> list[TomTom | Valhalla | OSRM]:
    available: dict[str, TomTom | Valhalla | OSRM] = {"valhalla": Valhalla(), "osrm": OSRM()}
    if settings.TOMTOM_API_KEY:
        available["tomtom"] = TomTom(settings.TOMTOM_API_KEY)
    return [available[name] for name in settings.ROUTING_PROVIDERS if name in available]


CELL_DEG = 0.004  # about 400 m
NEIGHBOURS = np.array([(i, j) for i in (-1, 0, 1) for j in (-1, 0, 1)])


def _cells(route: Route) -> npt.NDArray[np.int64]:
    """Grid cells the route passes through, sampled every 0.1 mi, as packed integer keys."""
    samples = points_at(route.points, route.cum_mi, np.arange(0.0, route.distance_mi, 0.1))
    ij = np.floor(samples / CELL_DEG).astype(np.int64)
    return np.unique(ij[:, 0] * 1_000_000 + ij[:, 1])


def overlap(route: Route, other: Route) -> float:
    """Share of `route`'s length that runs within one grid cell of `other`."""
    mine = _cells(route)
    theirs = _cells(other)
    near = np.unique((theirs[:, None] + (NEIGHBOURS[:, 0] * 1_000_000 + NEIGHBOURS[:, 1])[None, :]).ravel())
    return float(np.isin(mine, near).mean()) if len(mine) else 1.0


def distinct(candidates: Sequence[Route], limit: int = 3, threshold: float = DISTINCT_OVERLAP) -> list[Route]:
    """Candidates in order, skipping any that shares `threshold` or more of its road with one already kept."""
    chosen: list[Route] = []
    for route in candidates:
        if all(overlap(route, c) < threshold for c in chosen):
            chosen.append(route)
        if len(chosen) == limit:
            break
    return chosen


def route_names(routes: Sequence[Route], least_mi: float = 5.0) -> list[str]:
    """Each route's two main roads, and where routes share those, the road that tells it apart ("via US-169").

    The telling road is the one this route drives the most miles on beyond what any of its namesakes drive there;
    under `least_mi` of difference the name stays as it is.
    """
    base = [route.name() for route in routes]
    names = list(base)
    for i, route in enumerate(routes):
        twins = [other for j, other in enumerate(routes) if j != i and base[j] == base[i]]
        if not twins:
            continue
        main = set(base[i].split(" · "))

        def lead(road: str, route: Route = route, twins: list[Route] = twins) -> float:
            return route.roads[road] - max(twin.roads.get(road, 0.0) for twin in twins)

        best = max((road for road in route.roads if road not in main), key=lead, default=None)
        if best is not None and lead(best) >= least_mi:
            names[i] = f"{base[i]} via {best}"
    return names


def side_points(route: Route) -> list[Place]:
    """Two points off the route's midpoint, one on each side, at a seventh of the trip's straight-line length."""
    start, end = route.points[0], route.points[-1]
    straight = float(haversine_mi(start[0], start[1], end[0], end[1]))
    offset_mi = min(max(straight / 7, 15.0), 120.0)
    mid = points_at(route.points, route.cum_mi, [route.distance_mi * 0.5])[0]
    ahead = points_at(route.points, route.cum_mi, [min(route.distance_mi * 0.55, route.distance_mi)])[0]
    lat0 = math.radians(mid[0])
    dx = (ahead[1] - mid[1]) * math.cos(lat0)
    dy = ahead[0] - mid[0]
    norm = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / norm, dx / norm  # left of the direction of travel
    deg = offset_mi / 69.0
    return [
        Place(lat=float(mid[0] + side * ny * deg), lon=float(mid[1] + side * nx * deg / math.cos(lat0)))
        for side in (1, -1)
    ]


def find_routes(origin: Place, destination: Place, truck: Truck, departure: datetime) -> list[Route]:
    """Up to three distinct routes, fastest first, from the first provider that answers."""
    errors: list[str] = []
    for provider in providers():
        try:
            routes = provider.routes(origin, destination, truck, departure)
        except (UpstreamError, ValueError, KeyError) as exc:
            # ValueError and KeyError: an answer whose shape or times do not add up is treated as no answer.
            log.warning("routing provider %s failed: %s", provider.name, exc)
            errors.append(f"{provider.name}: {exc}")
            continue
        if not routes:
            continue
        # The engine's own alternatives are meant to differ; drop only near-duplicates of them.
        chosen = distinct(sorted(routes, key=lambda r: r.drive_s), threshold=DUPLICATE_OVERLAP)
        if len(chosen) < 3:
            fastest = chosen[0]
            for place in side_points(fastest):
                try:
                    extra = provider.via(origin, place, destination, truck, departure)
                except (UpstreamError, ValueError, KeyError) as exc:
                    log.info("routing provider %s: no route through %s: %s", provider.name, place, exc)
                    extra = None
                # A route through a side point must differ from every route kept so far; the kept ones stay.
                if (
                    extra
                    and extra.drive_s <= fastest.drive_s * MAX_DETOUR_FACTOR
                    and all(overlap(extra, kept) < DISTINCT_OVERLAP for kept in chosen)
                ):
                    chosen.append(extra)
                if len(chosen) == 3:
                    break
        return sorted(chosen, key=lambda r: r.drive_s)
    if errors:
        raise UpstreamError("routing", "; ".join(errors))
    return []
