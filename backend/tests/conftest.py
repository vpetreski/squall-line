from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from typing import Any

import pytest
from django.core.cache import cache

from planner import geocoding, http, routing, weather

from .replay import Replay, response


@pytest.fixture(autouse=True)
def _fresh_state() -> Iterator[None]:
    """Every test starts with an empty cache and a weather quota that is not spent."""
    cache.clear()
    weather.QUOTA.clear()
    yield
    cache.clear()
    weather.QUOTA.clear()


@pytest.fixture
def replay(monkeypatch: pytest.MonkeyPatch, settings: Any) -> Callable[[list[dict[str, Any]]], Replay]:
    """Install a replay of recorded exchanges as every module's HTTP client (keyless engines, as recorded)."""
    settings.TOMTOM_API_KEY = ""
    settings.ROUTING_PROVIDERS = ["valhalla", "osrm"]

    def install(exchanges: list[dict[str, Any]]) -> Replay:
        engines = [
            name for e in exchanges if e["service"] == "routing" for name in ("valhalla", "osrm") if name in e["url"]
        ]
        if engines:  # the engine that answered when the fixture was recorded comes first
            settings.ROUTING_PROVIDERS = list(dict.fromkeys([engines[0], "valhalla", "osrm"]))
        fake = Replay(exchanges)
        # The recordings hold no quota probe: start from a window with room, as the recording did.
        room = {"X-RateLimit-Remaining": "600", "X-RateLimit-Reset": str(int(time.time()) + 3600)}
        weather.QUOTA.note(response(200, {}, room))
        for module in (http, routing, weather, geocoding):
            monkeypatch.setattr(module, "request", fake)
        return fake

    return install
