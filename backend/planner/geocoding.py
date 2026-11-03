"""Type-ahead place search for US origins and destinations, and the time zone of a point.

TomTom's fuzzy search answers in a few hundred milliseconds and ranks towns before addresses and points of
interest; Photon (OpenStreetMap, keyless) is the fallback. A query that already is "lat, lon" is returned as is.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from functools import lru_cache
from urllib.parse import quote

import tzfpy
from django.conf import settings

from .http import Pace, UpstreamError, cache_key, cached, request

log = logging.getLogger(__name__)
COORDINATES = re.compile(r"^\s*(-?\d{1,2}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$")
CACHE_TTL_S = 24 * 3600


@dataclass(frozen=True, slots=True)
class Suggestion:
    label: str
    detail: str
    lat: float
    lon: float
    kind: str
    time_zone: str


@lru_cache(maxsize=4096)
def time_zone(lat: float, lon: float) -> str:
    return tzfpy.get_tz(lon, lat) or "UTC"


def _point(label: str, detail: str, lat: float, lon: float, kind: str) -> Suggestion:
    return Suggestion(
        label=label, detail=detail, lat=round(lat, 6), lon=round(lon, 6), kind=kind, time_zone=time_zone(lat, lon)
    )


def suggest(query: str, limit: int = 6) -> list[Suggestion]:
    text = " ".join(query.split())
    match = COORDINATES.match(text)
    if match:
        lat, lon = float(match[1]), float(match[2])
        if -90 <= lat <= 90 and -180 <= lon <= 180:
            return [_point(f"{lat:.5f}, {lon:.5f}", "Coordinates", lat, lon, "coordinates")]
        return []
    if len(text) < 2:
        return []
    found, _ = cached(cache_key("geocode", text.lower(), limit), CACHE_TTL_S, lambda: _search(text, limit))
    return found


def _search(text: str, limit: int) -> list[Suggestion]:
    if settings.TOMTOM_API_KEY:
        try:
            return _tomtom(text, limit)
        except UpstreamError as exc:
            log.warning("TomTom search failed, using Photon: %s", exc)
    return _photon(text, limit)


def _tomtom(text: str, limit: int) -> list[Suggestion]:
    response = request(
        "geocoding",
        "GET",
        f"https://api.tomtom.com/search/2/search/{quote(text, safe='')}.json",
        params={
            "key": settings.TOMTOM_API_KEY,
            "typeahead": "true",
            "limit": limit,
            "countrySet": "US",
            "language": "en-US",
            "idxSet": "Geo,PAD,Addr,Str,POI",
        },
        retries=0,
    )
    if response.status_code != 200:
        raise UpstreamError("geocoding", f"TomTom search: HTTP {response.status_code}", response.status_code)
    out: list[Suggestion] = []
    for r in response.json().get("results", []):
        address = r.get("address", {})
        place = address.get("freeformAddress") or address.get("municipality") or ""
        name = (r.get("poi") or {}).get("name")
        kind = {"Geography": "place", "POI": "poi", "Point Address": "address", "Street": "street"}.get(
            r.get("type", ""), "address"
        )
        label, detail = (name, place) if name else (place, address.get("countrySubdivisionName", ""))
        if label:
            out.append(_point(label, detail, r["position"]["lat"], r["position"]["lon"], kind))
    return _unique(out)


PHOTON_PACE = Pace(0.2)


def _photon(text: str, limit: int) -> list[Suggestion]:
    response = request(
        "geocoding",
        "GET",
        f"{settings.PHOTON_URL}/api",
        params={"q": text, "limit": limit * 2, "lang": "en", "lat": 39.8, "lon": -98.6},
        pace=PHOTON_PACE,
        retries=0,
    )
    if response.status_code != 200:
        raise UpstreamError("geocoding", f"Photon: HTTP {response.status_code}", response.status_code)
    out: list[Suggestion] = []
    for feature in response.json().get("features", []):
        p = feature.get("properties", {})
        if p.get("countrycode", "").upper() != "US":
            continue
        lon, lat = feature["geometry"]["coordinates"]
        town = p.get("city") or p.get("town") or p.get("village") or ""
        state = p.get("state", "")
        name = p.get("name") or town
        street = " ".join(x for x in (p.get("housenumber"), p.get("street")) if x)
        label = street if street and not p.get("name") else name
        detail = ", ".join(x for x in (town if town != label else "", state) if x)
        kind = "place" if p.get("type") in {"city", "town", "village", "state", "county", "district"} else "address"
        if label:
            out.append(_point(label, detail, lat, lon, kind))
    return _unique(out)[:limit]


def _unique(items: list[Suggestion]) -> list[Suggestion]:
    seen: set[tuple[str, str]] = set()
    out = []
    for s in items:
        if (s.label, s.detail) not in seen:
            seen.add((s.label, s.detail))
            out.append(s)
    return out
