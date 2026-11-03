from __future__ import annotations

from typing import Any

import httpx
import pytest

from planner import geocoding
from planner.geocoding import suggest, time_zone


def test_coordinates_come_back_as_they_are_with_their_time_zone(monkeypatch):
    monkeypatch.setattr(geocoding, "request", lambda *a, **k: pytest.fail("no search expected"))
    [s] = suggest("41.8832, -87.6324")
    assert (s.lat, s.lon, s.kind, s.time_zone) == (41.8832, -87.6324, "coordinates", "America/Chicago")
    assert suggest("95, 200") == []
    assert suggest("a") == []


@pytest.mark.parametrize(
    ("lat", "lon", "zone"),
    [
        (39.7392, -104.9903, "America/Denver"),
        (33.4484, -112.074, "America/Phoenix"),
        (40.7128, -74.006, "America/New_York"),
    ],
)
def test_time_zones(lat, lon, zone):
    assert time_zone(lat, lon) == zone


def test_tomtom_results_become_labels_and_are_cached(settings, monkeypatch):
    settings.TOMTOM_API_KEY = "k"
    calls: list[dict[str, Any]] = []
    results = [
        {
            "type": "Geography",
            "address": {"freeformAddress": "Denver, CO", "countrySubdivisionName": "Colorado"},
            "position": {"lat": 39.74, "lon": -104.99},
        },
        {
            "type": "POI",
            "poi": {"name": "Denver International Airport"},
            "address": {"freeformAddress": "8500 Peña Blvd, Denver, CO 80249"},
            "position": {"lat": 39.85, "lon": -104.67},
        },
        {
            "type": "Geography",
            "address": {"freeformAddress": "Denver, CO", "countrySubdivisionName": "Colorado"},
            "position": {"lat": 39.74, "lon": -104.99},
        },
    ]

    def answer(service: str, method: str, url: str, **kwargs: Any) -> httpx.Response:
        calls.append({"url": url, **kwargs["params"]})
        return httpx.Response(200, json={"results": results})

    monkeypatch.setattr(geocoding, "request", answer)
    found = suggest("denver")
    assert [(s.label, s.detail, s.kind) for s in found] == [
        ("Denver, CO", "Colorado", "place"),
        ("Denver International Airport", "8500 Peña Blvd, Denver, CO 80249", "poi"),
    ]
    assert calls[0]["countrySet"] == "US"
    assert calls[0]["typeahead"] == "true"
    assert suggest("  Denver ") == found  # same query after normalising: from the cache
    assert len(calls) == 1


def test_photon_is_the_fallback_and_keeps_only_us_places(settings, monkeypatch):
    settings.TOMTOM_API_KEY = "k"
    features = [
        {
            "properties": {"name": "Denver", "state": "Colorado", "countrycode": "US", "type": "city"},
            "geometry": {"coordinates": [-104.99, 39.74]},
        },
        {
            "properties": {"name": "Denver", "state": "Norfolk", "countrycode": "GB", "type": "village"},
            "geometry": {"coordinates": [0.38, 52.6]},
        },
        {
            "properties": {
                "housenumber": "1701",
                "street": "Wynkoop Street",
                "city": "Denver",
                "state": "Colorado",
                "countrycode": "US",
                "type": "house",
            },
            "geometry": {"coordinates": [-105.0, 39.75]},
        },
    ]

    def answer(service: str, method: str, url: str, **kwargs: Any) -> httpx.Response:
        if "tomtom" in url:
            return httpx.Response(503, json={})
        return httpx.Response(200, json={"features": features})

    monkeypatch.setattr(geocoding, "request", answer)
    found = suggest("denver wynkoop")
    assert [(s.label, s.detail, s.kind) for s in found] == [
        ("Denver", "Colorado", "place"),
        ("1701 Wynkoop Street", "Denver, Colorado", "address"),
    ]


def test_photon_failure_is_an_upstream_error(settings, monkeypatch):
    settings.TOMTOM_API_KEY = ""
    monkeypatch.setattr(geocoding, "request", lambda *a, **k: httpx.Response(502, json={}))
    with pytest.raises(geocoding.UpstreamError):
        suggest("reno")
