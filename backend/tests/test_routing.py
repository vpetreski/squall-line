from __future__ import annotations

import contextlib
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import numpy as np
import pytest
import respx

from planner import http, routing
from planner.geo import cumulative_miles, haversine_mi
from planner.http import UpstreamError
from planner.routing import Place, Route, TomTom, Truck, distinct, find_routes, overlap, route_names, side_points

CHICAGO = Place(41.8832, -87.6324)
DENVER = Place(39.7392, -104.9903)
NOW = datetime.now(UTC)


def line(a: Place, b: Place, n: int = 200, bend: float = 0.0) -> np.ndarray:
    t = np.linspace(0, 1, n)
    lat = a.lat + (b.lat - a.lat) * t + bend * np.sin(np.pi * t)
    lon = a.lon + (b.lon - a.lon) * t
    return np.column_stack([lat, lon])


def route(points: np.ndarray, hours: float, provider: str = "fake") -> Route:
    cum = cumulative_miles(points)
    return Route(points=points, cum_mi=cum, cum_drive_s=cum / cum[-1] * hours * 3600, provider=provider)


def tomtom_route(points: np.ndarray, total_s: float, delay_s: float = 0) -> dict[str, Any]:
    n = len(points)
    length_m = float(cumulative_miles(points)[-1]) * 1609.344 * 1.002  # the engine's own length differs a little
    instructions = [
        {"pointIndex": 0, "travelTimeInSeconds": 0, "routeOffsetInMeters": 0, "roadNumbers": ["I-80 W"]},
        {
            "pointIndex": n // 2,
            "travelTimeInSeconds": total_s * 0.6,
            "routeOffsetInMeters": length_m * 0.4,
            "roadNumbers": ["I-76"],
        },
        {"pointIndex": n - 1, "travelTimeInSeconds": total_s, "routeOffsetInMeters": length_m},
    ]
    return {
        "summary": {"lengthInMeters": length_m, "travelTimeInSeconds": total_s, "trafficDelayInSeconds": delay_s},
        "legs": [{"points": [{"latitude": a, "longitude": b} for a, b in points]}],
        "guidance": {"instructions": instructions},
    }


def test_tomtom_route_follows_its_instruction_times_and_roads():
    pts = line(CHICAGO, DENVER, n=101)
    r = TomTom("key")._route(tomtom_route(pts, total_s=10 * 3600, delay_s=120))
    assert r.distance_mi == pytest.approx(cumulative_miles(pts)[-1] * 1.002)
    assert r.drive_s == 10 * 3600
    assert r.cum_drive_s[50] == pytest.approx(6 * 3600)  # the instruction's own cumulative time
    assert np.all(np.diff(r.cum_drive_s) >= 0)
    assert r.traffic_delay_s == 120
    assert r.roads["I-80"] == pytest.approx(0.4 * r.distance_mi)
    assert r.roads["I-76"] == pytest.approx(0.6 * r.distance_mi)
    assert r.name() == "I-76 · I-80"
    assert r.provider == "tomtom"


def test_tomtom_asks_for_a_truck_with_its_weight_and_speed(monkeypatch):
    sent: dict[str, Any] = {}

    def answer(service: str, method: str, url: str, **kwargs: Any) -> httpx.Response:
        sent.update(kwargs["params"], url=url)
        return httpx.Response(200, json={"routes": [tomtom_route(line(CHICAGO, DENVER), 36000)]})

    monkeypatch.setattr(routing, "request", answer)
    truck = Truck(load_lb=40_000)
    routes = TomTom("secret").routes(CHICAGO, DENVER, truck, NOW - timedelta(minutes=30))
    assert len(routes) == 1
    assert sent["travelMode"] == "truck"
    assert sent["vehicleWeight"] == round(75_000 / 2.20462262)
    assert sent["vehicleMaxSpeed"] == 105
    assert sent["maxAlternatives"] == 2
    assert sent["departAt"] == "now"  # TomTom refuses a departure in the past
    assert "41.883200,-87.632400:39.739200,-104.990300" in sent["url"]

    later = NOW + timedelta(hours=5)
    TomTom("secret").routes(CHICAGO, DENVER, truck, later)
    assert sent["departAt"] == later.isoformat(timespec="seconds")


def test_a_tomtom_route_through_a_side_point_is_asked_for_the_same_truck(monkeypatch):
    sent: list[dict[str, Any]] = []

    def answer(service: str, method: str, url: str, **kwargs: Any) -> httpx.Response:
        sent.append(dict(kwargs["params"], url=url))
        return httpx.Response(200, json={"routes": [tomtom_route(line(CHICAGO, DENVER), 36000)]})

    monkeypatch.setattr(routing, "request", answer)
    truck = Truck(load_lb=40_000)
    engine = TomTom("secret")
    engine.routes(CHICAGO, DENVER, truck, NOW)
    assert engine.via(CHICAGO, Place(41.0, -96.0), DENVER, truck, NOW) is not None
    main, through = sent
    assert "41.883200,-87.632400:41.000000,-96.000000:39.739200,-104.990300" in through["url"]
    assert (main["vehicleLength"], main["vehicleWidth"], main["vehicleHeight"]) == (21.9, 2.6, 4.11)
    assert {k: v for k, v in main.items() if k not in ("url", "maxAlternatives")} == {
        k: v for k, v in through.items() if k != "url"
    }


def test_tomtom_no_route_is_an_empty_answer_and_other_errors_are_upstream_errors(monkeypatch):
    replies = iter(
        [
            httpx.Response(400, json={"detailedError": {"code": "NO_ROUTE_FOUND", "message": "No route found."}}),
            httpx.Response(403, json={"detailedError": {"message": "Forbidden"}}),
        ]
    )
    monkeypatch.setattr(routing, "request", lambda *a, **k: next(replies))
    assert TomTom("k").routes(CHICAGO, DENVER, Truck(0), NOW) == []
    with pytest.raises(UpstreamError, match="Forbidden"):
        TomTom("k").routes(CHICAGO, DENVER, Truck(0), NOW)


ENGINES = {"tomtom": lambda: TomTom("k"), "valhalla": routing.Valhalla, "osrm": routing.OSRM}
INDIANAPOLIS = Place(39.7684, -86.1581)


@respx.mock
@pytest.mark.parametrize("engine", list(ENGINES))
def test_a_routing_read_timeout_is_not_retried_but_a_failed_connection_is(engine, monkeypatch):
    monkeypatch.setattr(http.time, "sleep", lambda s: None)
    upstream = respx.route().mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(UpstreamError, match="did not answer in time"):
        ENGINES[engine]().routes(CHICAGO, INDIANAPOLIS, Truck(0), NOW)
    assert upstream.call_count == 1
    with contextlib.suppress(UpstreamError):
        ENGINES[engine]().via(CHICAGO, Place(40.5, -87.5), INDIANAPOLIS, Truck(0), NOW)
    assert upstream.call_count == 2

    upstream.reset()
    upstream.side_effect = httpx.ConnectError("refused")
    with pytest.raises(UpstreamError, match="could not be reached"):
        ENGINES[engine]().routes(CHICAGO, INDIANAPOLIS, Truck(0), NOW)
    assert upstream.call_count == 2


def test_overlap_and_distinct():
    a = route(line(CHICAGO, DENVER), 15)
    same = route(line(CHICAGO, DENVER, n=333), 15.5)
    apart = route(line(CHICAGO, DENVER, bend=1.5), 17)
    assert overlap(a, same) == pytest.approx(1.0)
    assert overlap(a, apart) < 0.2
    assert distinct([a, same, apart]) == [a, apart]


def test_side_points_lie_on_both_sides_of_the_midpoint():
    r = route(line(CHICAGO, DENVER), 15)
    left, right = side_points(r)
    straight = float(haversine_mi(CHICAGO.lat, CHICAGO.lon, DENVER.lat, DENVER.lon))
    offset = min(max(straight / 7, 15), 120)
    mid = r.points[len(r.points) // 2]
    for p in (left, right):
        assert float(haversine_mi(mid[0], mid[1], p.lat, p.lon)) == pytest.approx(offset, rel=0.05)
    assert (left.lat - mid[0]) * (right.lat - mid[0]) < 0


class Fake:
    def __init__(self, name: str, routes: list[Route] | Exception, via: list[Route | None] | None = None):
        self.name = name
        self._routes = routes
        self._via = list(via or [])
        self.via_calls = 0

    def routes(self, *args: Any) -> list[Route]:
        if isinstance(self._routes, Exception):
            raise self._routes
        return self._routes

    def via(self, *args: Any) -> Route | None:
        self.via_calls += 1
        return self._via.pop(0) if self._via else None


def test_the_first_engine_that_answers_is_used(monkeypatch):
    good = [route(line(CHICAGO, DENVER, bend=b), 15 + b) for b in (0, 1.5, -1.5)]
    engines = [Fake("broken", UpstreamError("routing", "down")), Fake("odd", ValueError("times")), Fake("ok", good)]
    monkeypatch.setattr(routing, "providers", lambda: engines)
    assert find_routes(CHICAGO, DENVER, Truck(0), NOW) == sorted(good, key=lambda r: r.drive_s)


def test_every_engine_failing_is_an_upstream_error_and_no_route_is_empty(monkeypatch):
    monkeypatch.setattr(routing, "providers", lambda: [Fake("a", UpstreamError("routing", "down"))])
    with pytest.raises(UpstreamError, match="a: down"):
        find_routes(CHICAGO, DENVER, Truck(0), NOW)
    monkeypatch.setattr(routing, "providers", lambda: [Fake("a", [])])
    assert find_routes(CHICAGO, DENVER, Truck(0), NOW) == []


def test_missing_alternatives_come_from_routes_through_side_points(monkeypatch):
    main = route(line(CHICAGO, DENVER), 15)
    north = route(line(CHICAGO, DENVER, bend=1.5), 17)
    too_long = route(line(CHICAGO, DENVER, bend=-1.5), 30)  # more than 1.5 times the fastest
    engine = Fake("ok", [main], via=[north, too_long])
    monkeypatch.setattr(routing, "providers", lambda: [engine])
    assert find_routes(CHICAGO, DENVER, Truck(0), NOW) == [main, north]
    assert engine.via_calls == 2


def test_an_engine_alternative_stays_while_side_points_fill_the_last_place(monkeypatch):
    main = route(line(CHICAGO, DENVER, n=400), 15)
    close_points = line(CHICAGO, DENVER, n=400)
    close_points[160:200, 0] += 0.1  # leaves the main road for a tenth of the trip, about 11 km north
    close = route(close_points, 15.5)
    alike = route(line(CHICAGO, DENVER, n=333), 16)  # through a side point, back on the main road
    north = route(line(CHICAGO, DENVER, bend=1.5), 17)
    assert 0.8 <= overlap(close, main) < 0.97
    engine = Fake("ok", [main, close], via=[alike, north])
    monkeypatch.setattr(routing, "providers", lambda: [engine])
    assert find_routes(CHICAGO, DENVER, Truck(0), NOW) == [main, close, north]
    assert engine.via_calls == 2


def test_providers_follow_the_settings_and_need_a_key_for_tomtom(settings):
    settings.ROUTING_PROVIDERS = ["tomtom", "valhalla", "osrm"]
    settings.TOMTOM_API_KEY = ""
    assert [p.name for p in routing.providers()] == ["valhalla", "osrm"]
    settings.TOMTOM_API_KEY = "k"
    assert [p.name for p in routing.providers()] == ["tomtom", "valhalla", "osrm"]


def test_valhalla_refuses_trips_beyond_its_public_server_limit(monkeypatch):
    monkeypatch.setattr(routing, "request", lambda *a, **k: pytest.fail("no request expected"))
    assert routing.Valhalla().routes(Place(40.71, -74.0), Place(34.05, -118.24), Truck(0), NOW) == []


def test_truck_weight_and_speed():
    t = Truck(load_lb=45_000)
    assert t.gross_kg == round(80_000 / 2.20462262)
    assert t.max_speed_mps == pytest.approx(105 / 3.6)


def named(roads: dict[str, float]) -> Route:
    pts = line(CHICAGO, DENVER, n=3)
    return Route(points=pts, cum_mi=cumulative_miles(pts), cum_drive_s=np.zeros(3), roads=roads)


def test_routes_on_the_same_main_roads_are_told_apart_by_the_road_only_one_takes():
    a = named({"I-35": 300, "US-69": 100, "US-169": 30, "MO-13": 2})
    b = named({"I-35": 280, "US-69": 120, "MO-13": 40})
    c = named({"I-29": 400, "US-75": 100, "US-169": 60})
    assert route_names([a, b, c]) == ["I-35 · US-69 via US-169", "I-35 · US-69 via MO-13", "I-29 · US-75"]


def test_a_route_without_a_road_of_its_own_keeps_its_name():
    a = named({"I-35": 300, "US-69": 100, "US-169": 30})
    b = named({"I-35": 310, "US-69": 120})
    close = named({"I-35": 290, "US-69": 110, "US-169": 27})  # within 5 mi of `a` on US-169
    assert route_names([a, b]) == ["I-35 · US-69 via US-169", "I-35 · US-69"]
    assert route_names([a, close]) == ["I-35 · US-69", "I-35 · US-69"]
    assert route_names([named({}), named({"I-80": 10})]) == ["Local roads", "I-80"]
