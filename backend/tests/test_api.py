from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from django.test import Client

from planner import routing, service
from planner.http import UpstreamError

CHICAGO = {"lat": 41.8832, "lon": -87.6324, "label": "Chicago, IL"}
DENVER = {"lat": 39.7392, "lon": -104.9903, "label": "Denver, CO"}


@pytest.fixture
def client() -> Client:
    return Client(HTTP_HOST="localhost")


def post(client: Client, body: dict[str, Any]):
    return client.post("/api/plan", json.dumps(body), content_type="application/json")


def trip(**changes: Any) -> dict[str, Any]:
    soon = (datetime.now(UTC) + timedelta(hours=2)).isoformat(timespec="minutes")
    return {"origin": CHICAGO, "destination": DENVER, "departure": soon, "load_lb": 30_000} | changes


def test_health_names_the_routing_engines(client, settings):
    settings.TOMTOM_API_KEY = ""
    settings.ROUTING_PROVIDERS = ["tomtom", "valhalla", "osrm"]
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "routing": ["valhalla", "osrm"]}


def test_rules_are_served_as_data(client):
    r = client.get("/api/rules")
    assert r.status_code == 200
    body = r.json()
    assert body["levels"] == ["low", "moderate", "high", "severe", "no_travel"]
    assert body["wind"]["no_travel"] == 55
    assert [rule["over_lb"] for rule in body["load_rules"]] == [30_000, 40_000]


def test_geocode_answers_coordinates_without_a_search(client):
    r = client.get("/api/geocode", {"q": "39.7392,-104.9903"})
    assert r.status_code == 200
    [result] = r.json()["results"]
    assert result["time_zone"] == "America/Denver"


def test_geocode_upstream_failure_is_a_503(client, monkeypatch):
    def down(*args: Any) -> None:
        raise UpstreamError("geocoding", "down")

    monkeypatch.setattr("planner.geocoding.suggest", down)
    r = client.get("/api/geocode", {"q": "reno"})
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "geocoding_unavailable"


@pytest.mark.parametrize(
    ("body", "field"),
    [
        ({"origin": CHICAGO, "destination": DENVER, "load_lb": 1000}, "departure"),
        (trip(load_lb=-5), "load_lb"),
        (trip(load_lb=90_000), "load_lb"),
        (trip(interval_mi=15), "interval_mi"),
        (trip(origin={"lat": 95, "lon": 0}), "origin.lat"),
    ],
)
def test_invalid_requests_name_the_field(client, body, field):
    r = post(client, body)
    assert r.status_code == 422
    error = r.json()["error"]
    assert error["code"] == "invalid_request"
    assert field in error["fields"]


def test_a_body_that_is_not_json_is_rejected(client):
    r = client.post("/api/plan", "{not json", content_type="application/json")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "invalid_json"


@pytest.mark.parametrize(
    ("changes", "code"),
    [
        ({"departure": "tomorrow morning"}, "invalid_departure"),
        ({"departure": (datetime.now(UTC) - timedelta(hours=3)).isoformat()}, "departure_in_past"),
        ({"departure": (datetime.now(UTC) + timedelta(days=9)).isoformat()}, "departure_too_far"),
        ({"destination": CHICAGO}, "same_place"),
    ],
)
def test_plan_errors_explain_themselves(client, changes, code, monkeypatch):
    monkeypatch.setattr(routing, "find_routes", lambda *a: pytest.fail("no routing expected"))
    r = post(client, trip(**changes))
    assert r.status_code == 422
    assert r.json()["error"]["code"] == code


def test_no_route_and_routing_outages(client, monkeypatch):
    monkeypatch.setattr(routing, "find_routes", lambda *a: routing.Found([]))
    r = post(client, trip())
    assert (r.status_code, r.json()["error"]["code"]) == (422, "no_route")

    def down(*args: Any) -> None:
        raise UpstreamError("routing", "every engine failed")

    monkeypatch.setattr(routing, "find_routes", down)
    r = post(client, trip(load_lb=31_000))  # another routing bucket: not cached
    assert (r.status_code, r.json()["error"]["code"]) == (503, "routing_unavailable")


def test_naive_departures_are_local_time_at_the_origin():
    now = datetime(2026, 11, 3, 18, 0, tzinfo=UTC)
    when = service.resolve_departure("2026-11-04T08:00", "America/Chicago", now)
    assert when.isoformat() == "2026-11-04T08:00:00-06:00"
    with_offset = service.resolve_departure("2026-11-04T08:00-05:00", "America/Chicago", now)
    assert with_offset.utcoffset() == timedelta(hours=-5)


def test_the_spa_is_served_for_any_other_path(client, settings, tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>Squall Line</title>")
    settings.SPA_DIR = tmp_path
    r = client.get("/trips/123")
    assert r.status_code == 200
    assert b"Squall Line" in b"".join(r.streaming_content)
    settings.SPA_DIR = tmp_path / "missing"
    assert client.get("/").status_code == 404


def test_built_assets_are_served_with_a_long_cache_life(settings, tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<!doctype html><title>Squall Line</title>")
    (tmp_path / "assets" / "index-Dv2hfonB.js").write_text("export {};")
    (tmp_path / "favicon.svg").write_text("<svg/>")
    settings.WHITENOISE_ROOT = tmp_path
    client = Client()  # a new handler, so the static file middleware reads the new root
    hashed = client.get("/assets/index-Dv2hfonB.js")
    assert hashed.status_code == 200
    assert "immutable" in hashed["Cache-Control"]
    plain = client.get("/favicon.svg")
    assert plain.status_code == 200
    assert "immutable" not in plain["Cache-Control"]


def test_interactive_docs_render(client):
    r = client.get("/api/docs")
    assert r.status_code == 200
    assert b"swagger-ui" in r.content


def test_openapi_document_is_published(client):
    r = client.get("/api/openapi.json")
    assert r.status_code == 200
    assert "/api/plan" in r.json()["paths"]
