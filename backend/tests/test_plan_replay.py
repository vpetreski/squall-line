"""The whole pipeline on recorded answers from the routing engines and Open-Meteo (no network)."""

from __future__ import annotations

import json
from datetime import datetime
from typing import Any

import numpy as np
import pytest
from django.core.cache import cache
from django.test import Client

from planner import corridor, http, routing, service, weather
from planner.schemas import PlanIn, PlanOut

from .replay import load, response

CASES = ["chicago-atlanta", "denver-salt-lake-osrm", "sacramento-reno"]
LEVELS = ["low", "moderate", "high", "severe", "no_travel"]


def plan(fixture: dict[str, Any], **changes: Any) -> dict[str, Any]:
    payload = PlanIn(**(fixture["payload"] | changes))
    return service.plan(payload, now=datetime.fromisoformat(fixture["now"]))


@pytest.fixture(params=CASES)
def case(request: pytest.FixtureRequest) -> dict[str, Any]:
    return load(request.param)


def test_plan_matches_the_contract(case, replay):
    replay(case["exchanges"])
    out = plan(case)
    PlanOut.model_validate(out)
    assert [r["rank"] for r in out["routes"]] == [1, 2, 3]
    assert out["routes"][0]["recommended"]
    assert sum(r["recommended"] for r in out["routes"]) == 1
    assert out["recommendation"]["route_id"] == out["routes"][0]["id"]
    assert sorted(r["id"] for r in out["routes"]) == ["A", "B", "C"]
    assert out["meta"]["weather_locations"] <= 450


def test_checkpoints_sit_at_the_interval_and_cover_the_route(case, replay):
    replay(case["exchanges"])
    out = plan(case)
    interval = case["payload"]["interval_mi"]
    for route in out["routes"]:
        cps = route["checkpoints"]
        miles = np.array([c["mile"] for c in cps])
        assert miles[0] == 0
        assert miles[-1] == pytest.approx(route["distance_mi"], abs=0.06)
        np.testing.assert_allclose(np.diff(miles)[:-1], interval, atol=0.011)
        assert 0 < np.diff(miles)[-1] <= interval * 1.1 + 0.01
        assert sum(c["represents_mi"] for c in cps) == pytest.approx(route["distance_mi"], abs=0.01 * len(cps))
        etas = [datetime.fromisoformat(c["eta"]) for c in cps]
        assert etas == sorted(etas)
        assert etas[0] == datetime.fromisoformat(route["departure"])
        assert etas[-1] == datetime.fromisoformat(route["arrival"])
        assert sum(route["miles"].values()) == pytest.approx(route["distance_mi"], abs=0.3)
        assert route["worst"] == max((c["risk"]["level"] for c in cps), key=LEVELS.index)


def test_ranking_follows_the_keys(case, replay):
    replay(case["exchanges"])
    out = plan(case)

    def key(r: dict[str, Any]) -> tuple:
        m = r["miles"]
        return (m["no_travel"], m["severe"], m["high"], r["average_risk"], round(r["trip_s"]), r["id"])

    routes = out["routes"]
    assert routes == sorted(routes, key=key)
    for comparison, other in zip(out["recommendation"]["comparisons"], routes[1:], strict=True):
        assert comparison["route_id"] == other["id"]
        if comparison["key"] is not None:
            assert comparison["best"] < comparison["other"]


def test_hours_of_service_add_the_stops(replay):
    fixture = load("chicago-atlanta")
    replay(fixture["exchanges"])
    route = plan(fixture)["routes"][0]
    hours = route["drive_s"] / 3600
    assert hours > 8  # long enough for at least the 30-minute break
    expected = ["break"] + (["rest"] if hours > 11 else [])
    assert [s["kind"] for s in route["stops"]] == expected
    stopped = 30 * 60 + (10 * 3600 if hours > 11 else 0)
    assert route["trip_s"] == pytest.approx(route["drive_s"] + stopped, abs=1)
    timeline = route["timeline"]
    assert timeline[0] == [0.0, 0.0]
    assert [t for t, _ in timeline] == sorted(t for t, _ in timeline)
    assert timeline[-1][1] == pytest.approx(route["distance_mi"], abs=0.06)  # distance is shown to 0.1 mi


def test_corridor_has_49_hourly_frames(case, replay):
    replay(case["exchanges"])
    c = plan(case)["corridor"]
    assert c["frames"] == corridor.FRAMES == 49
    assert c["step_s"] == 3600
    cells = len(c["cells"])
    assert 100 <= cells <= 300
    assert max(c["cells"]) < c["cols"] * c["rows"]
    for layer in ("risk", "wind_mph", "rain_in_hr", "snow_in_hr"):
        assert len(c[layer]) == 49
        assert all(len(frame) == cells for frame in c[layer])
    assert {v for frame in c["risk"] for v in frame} <= {0, 1, 2, 3, 4}
    west, south, east, north = c["bounds"]
    assert west < east
    assert south < north


def test_a_repeat_plan_is_served_from_the_caches(case, replay):
    replay(case["exchanges"])
    first = plan(case)
    fake = replay([])  # any request now fails the test
    second = plan(case)
    assert fake.calls == []
    assert second["meta"]["cached_routes"]
    assert second["meta"]["weather_downloaded"] == 0
    assert second["meta"]["weather_cached"] == second["meta"]["weather_locations"]
    assert second["routes"] == first["routes"]


def test_a_heavier_load_reuses_routes_and_weather_when_the_bucket_matches(replay):
    fixture = load("sacramento-reno")
    replay(fixture["exchanges"])
    plan(fixture)
    replay([])
    out = plan(fixture, load_lb=fixture["payload"]["load_lb"] + 400)  # same 1,000 lb routing bucket
    assert out["meta"]["cached_routes"]
    assert out["meta"]["weather_downloaded"] == 0


def test_routes_are_kept_for_hours_unless_the_answer_is_degraded(replay, monkeypatch, settings):
    fixture = load("sacramento-reno")
    lifetimes: dict[str, int] = {}
    shared = http.cache

    class Recording:
        """The cache behind `http.cached`, noting the lifetime each kind of entry is stored for."""

        def get(self, key: str) -> Any:
            return shared.get(key)

        def set(self, key: str, value: Any, timeout: int) -> None:
            lifetimes[key.split(":")[0]] = timeout
            shared.set(key, value, timeout)

    monkeypatch.setattr(http, "cache", Recording())
    replay(fixture["exchanges"])
    complete = plan(fixture)
    assert lifetimes["routes2"] == service.ROUTE_CACHE_S == 6 * 3600

    # The first engine fails and the next one answers with the same routes: they are kept for ten minutes only.
    cache.clear()
    replay(fixture["exchanges"])
    settings.ROUTING_PROVIDERS = ["osrm", "valhalla"]

    def down(*args: Any) -> None:
        raise http.UpstreamError("routing", "OSRM: busy", 503)

    monkeypatch.setattr(routing.OSRM, "routes", down)
    fallback = plan(fixture)
    assert fallback["routes"] == complete["routes"]
    assert lifetimes["routes2"] == service.ROUTE_RETRY_S == 10 * 60


def _refuse_weather(exchanges: list[dict[str, Any]], status: int = 429) -> list[dict[str, Any]]:
    refused = {"error": True, "reason": "Minutely API request limit exceeded. Please try again in one minute."}
    return [(e | {"status": status, "body": refused}) if e["service"] == "weather" else e for e in exchanges]


def test_a_spent_quota_relays_the_query_and_the_relayed_answer_completes_the_plan(replay):
    fixture = load("chicago-atlanta")
    replay(fixture["exchanges"])
    expected_routes = plan(fixture)["routes"]

    cache.clear()
    replay(_refuse_weather(fixture["exchanges"]))
    with pytest.raises(weather.WeatherRelay) as refused:
        plan(fixture)
    relay = refused.value.query
    assert refused.value.code == "weather_rate_limited"
    assert relay["url"] == "https://api.open-meteo.com/v1/forecast"
    assert "apikey" not in relay["form"]
    assert len(relay["locations"]) == len(relay["form"]["latitude"].split(","))
    assert weather.QUOTA.blocked()

    # The quota is spent: the next attempt does not even ask, it relays at once.
    replay([])
    with pytest.raises(weather.WeatherRelay):
        plan(fixture)

    # The browser fetched the forecast itself; the plan completes from it, with no request from the server.
    recorded = next(e["body"] for e in fixture["exchanges"] if e["service"] == "weather")
    out = plan(fixture, weather={"locations": relay["locations"], "response": recorded})
    assert out["meta"]["weather_supplied"] == len(relay["locations"])
    assert out["meta"]["weather_downloaded"] == 0
    assert out["routes"] == expected_routes


def test_a_supplied_forecast_never_enters_the_shared_cache(replay):
    fixture = load("sacramento-reno")
    replay(_refuse_weather(fixture["exchanges"]))
    with pytest.raises(weather.WeatherRelay) as refused:
        plan(fixture)
    relay = refused.value.query
    recorded = next(e["body"] for e in fixture["exchanges"] if e["service"] == "weather")
    plan(fixture, weather={"locations": relay["locations"], "response": recorded})
    keys = [weather._key(weather.Location(lat, lon)) for lat, lon in relay["locations"]]
    assert cache.get_many(keys) == {}


def test_a_malformed_supplied_forecast_is_a_client_error(replay):
    fixture = load("sacramento-reno")
    replay(_refuse_weather(fixture["exchanges"]))
    with pytest.raises(weather.WeatherRelay) as refused:
        plan(fixture)
    relay = refused.value.query
    with pytest.raises(service.PlanError) as bad:
        plan(fixture, weather={"locations": relay["locations"], "response": [{"hourly": {"time": [0]}}]})
    assert bad.value.code == "invalid_weather"


def _at_recording_time(monkeypatch: pytest.MonkeyPatch, fixture: dict[str, Any]) -> None:
    """Make the API plan as if it ran when the fixture was recorded."""
    real = service.plan
    now = datetime.fromisoformat(fixture["now"])
    monkeypatch.setattr(service, "plan", lambda payload: real(payload, now=now))


def test_the_api_plans_a_trip(replay, monkeypatch):
    fixture = load("sacramento-reno")
    replay(fixture["exchanges"])
    _at_recording_time(monkeypatch, fixture)
    out = Client(HTTP_HOST="localhost").post(
        "/api/plan", json.dumps(fixture["payload"]), content_type="application/json"
    )
    assert out.status_code == 200
    PlanOut.model_validate(out.json())


def test_the_api_answers_a_spent_quota_with_the_relay(replay, monkeypatch):
    fixture = load("sacramento-reno")
    replay(_refuse_weather(fixture["exchanges"]))
    _at_recording_time(monkeypatch, fixture)
    out = Client(HTTP_HOST="localhost").post(
        "/api/plan", json.dumps(fixture["payload"]), content_type="application/json"
    )
    assert out.status_code == 503
    error = out.json()["error"]
    assert error["code"] == "weather_rate_limited"
    assert error["relay"]["form"]["hourly"] == ",".join(weather.HOURLY)


@pytest.mark.parametrize(
    ("field", "token"),
    [("wind_speed_10m", "1e999"), ("rain", "NaN"), ("snowfall", "-Infinity"), ("time", "1e999")],
)
def test_the_api_rejects_a_supplied_forecast_that_is_not_finite(replay, monkeypatch, field, token):
    fixture = load("sacramento-reno")
    replay(_refuse_weather(fixture["exchanges"]))
    _at_recording_time(monkeypatch, fixture)
    client = Client(HTTP_HOST="localhost", raise_request_exception=False)
    relayed = client.post("/api/plan", json.dumps(fixture["payload"]), content_type="application/json")
    relay = relayed.json()["error"]["relay"]

    # The browser's answer, with one location's column replaced by a number JSON parsers read as inf or NaN.
    answer = json.loads(json.dumps(next(e["body"] for e in fixture["exchanges"] if e["service"] == "weather")))
    column = answer[0]["hourly"][field]
    answer[0]["hourly"][field] = ["NOT_FINITE"] * len(column)
    body = fixture["payload"] | {"weather": {"locations": relay["locations"], "response": answer}}
    raw = json.dumps(body).replace('"NOT_FINITE"', token)
    out = client.post("/api/plan", raw, content_type="application/json")
    assert out.status_code == 422
    error = out.json()["error"]
    assert error["code"] == "invalid_weather"
    assert error["message"].startswith("The supplied forecast cannot be used: a forecast is malformed")


def test_weather_that_times_out_is_relayed_too(replay, monkeypatch):
    fixture = load("sacramento-reno")
    replay([e for e in fixture["exchanges"] if e["service"] != "weather"])

    def slow(*args: Any, **kwargs: Any) -> None:
        raise weather.UpstreamError("weather", "weather did not answer in time", timeout=True)

    monkeypatch.setattr(weather, "request", slow)
    with pytest.raises(weather.WeatherRelay) as refused:
        plan(fixture)
    assert refused.value.code == "weather_timeout"
    assert not weather.QUOTA.blocked()


def test_an_open_meteo_error_is_relayed_as_unavailable(replay):
    fixture = load("sacramento-reno")
    replay(_refuse_weather(fixture["exchanges"], status=502))
    with pytest.raises(weather.WeatherRelay) as refused:
        plan(fixture)
    assert refused.value.code == "weather_unavailable"


def test_quota_headers_block_further_downloads(replay):
    fixture = load("sacramento-reno")
    exchanges = [
        (e | {"headers": {"X-RateLimit-Remaining": "-12.0", "X-RateLimit-Reset": "9999999999"}})
        if e["service"] == "weather"
        else e
        for e in fixture["exchanges"]
    ]
    replay(exchanges)
    plan(fixture)  # this answer was admitted, and it spent the minute
    assert weather.QUOTA.blocked()


def test_no_safe_route_is_reported_when_every_route_meets_no_travel(replay):
    fixture = load("sacramento-reno")
    stormy = []
    for e in fixture["exchanges"]:
        if e["service"] == "weather":
            body = json.loads(json.dumps(e["body"]))
            for item in body:
                hours = len(item["hourly"]["time"])
                item["hourly"] |= {"wind_speed_10m": [60.0] * hours, "rain": [0.0] * hours}
                item["hourly"] |= {"showers": [0.0] * hours, "snowfall": [0.0] * hours}
            e = e | {"body": body}
        stormy.append(e)
    replay(stormy)
    out = plan(fixture)
    assert out["recommendation"]["no_safe_route"]
    assert all(r["worst"] == "no_travel" for r in out["routes"])
    assert all(r["miles"]["no_travel"] == pytest.approx(r["distance_mi"], abs=0.1) for r in out["routes"])
    hazard = out["routes"][0]["hazards"][0]
    assert hazard["level"] == "no_travel"
    assert hazard["causes"] == ["wind"]


def test_a_load_rule_raises_the_wind_level(replay):
    fixture = load("sacramento-reno")
    windy = []
    for e in fixture["exchanges"]:
        if e["service"] == "weather":
            body = json.loads(json.dumps(e["body"]))
            for item in body:
                item["hourly"]["wind_speed_10m"] = [40.0] * len(item["hourly"]["time"])  # High
                item["hourly"]["rain"] = [0.0] * len(item["hourly"]["time"])
                item["hourly"]["showers"] = [0.0] * len(item["hourly"]["time"])
                item["hourly"]["snowfall"] = [0.0] * len(item["hourly"]["time"])
            e = e | {"body": body}
        windy.append(e)
    replay(windy)
    light = plan(fixture, load_lb=40_000)
    replay([])
    heavy = plan(fixture, load_lb=40_001)  # same routing bucket, same cached weather
    assert {c["risk"]["level"] for c in light["routes"][0]["checkpoints"]} == {"high"}
    assert {c["risk"]["level"] for c in heavy["routes"][0]["checkpoints"]} == {"severe"}
    assert heavy["routes"][0]["checkpoints"][0]["risk"]["load_rule"] == "wind_35_over_40000_lb"
    assert set(light["corridor"]["risk"][0]) == {2}
    assert set(heavy["corridor"]["risk"][0]) == {3}


def test_checkpoints_and_corridor_round_half_way_values_alike(replay):
    fixture = load("sacramento-reno")
    half_way = []
    for e in fixture["exchanges"]:
        if e["service"] == "weather":
            body = json.loads(json.dumps(e["body"]))
            for item in body:
                hours = len(item["hourly"]["time"])
                calm = [0.0] * hours
                # 0.2495 * 1000 is 249.5 in float64: 0.250 in/hr, High, wherever it is classified or shown.
                item["hourly"] |= {"rain": [0.2495] * hours, "showers": calm, "wind_speed_10m": calm, "snowfall": calm}
            e = e | {"body": body}
        half_way.append(e)
    replay(half_way)
    out = plan(fixture)
    checkpoints = [c for r in out["routes"] for c in r["checkpoints"]]
    assert {c["risk"]["level"] for c in checkpoints} == {"high"}
    assert {c["weather"]["rain_in_hr"] for c in checkpoints} == {0.25}
    assert {v for frame in out["corridor"]["risk"] for v in frame} == {2}
    assert {v for frame in out["corridor"]["rain_in_hr"] for v in frame} == {0.25}


def test_snapping_reports_its_grid(replay):
    fixture = load("chicago-atlanta")
    replay(fixture["exchanges"])
    meta = plan(fixture)["meta"]
    assert tuple(meta["weather_grid_deg"]) == (0.01, 0.01)
    assert meta["weather_snapped"] == 0


def test_a_recorded_answer_with_a_wrong_time_axis_is_rejected(replay):
    fixture = load("sacramento-reno")
    shifted = []
    for e in fixture["exchanges"]:
        if e["service"] == "weather":
            body = json.loads(json.dumps(e["body"]))
            for item in body:
                item["hourly"]["time"] = [t + 3600 for t in item["hourly"]["time"]]
            e = e | {"body": body}
        shifted.append(e)
    replay(shifted)
    with pytest.raises(weather.UpstreamError, match="unexpected hour"):
        plan(fixture)


def test_response_helper_round_trips():
    r = response(200, {"a": 1})
    assert r.json() == {"a": 1}
