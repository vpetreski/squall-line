"""Record every upstream exchange of one plan into a fixture for tests/test_plan_replay.py.

Run from backend/, one trip per call, at least a minute apart (Open-Meteo's free quota is per minute):

    .venv/bin/python tests/fixtures/record.py chicago-atlanta.json.gz '{"origin": ..., "departure": ...}'

Only the keyless engines are recorded (TomTom answers are not redistributable), and nothing secret is stored:
the requests carry no keys.
"""

from __future__ import annotations

import gzip
import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
os.environ["ROUTING_PROVIDERS"] = os.environ.get("RECORD_PROVIDERS", "valhalla,osrm")
os.environ["TOMTOM_API_KEY"] = ""
os.environ["OPEN_METEO_API_KEY"] = ""

import django

django.setup()

import httpx  # noqa: E402

from planner import geocoding, http, routing, service, weather  # noqa: E402
from planner.schemas import PlanIn  # noqa: E402


def main(name: str, payload: dict[str, Any]) -> None:
    exchanges: list[dict[str, Any]] = []
    real = http.request

    def recording(service_name: str, method: str, url: str, **kwargs: Any) -> httpx.Response:
        response = real(service_name, method, url, **kwargs)
        exchanges.append(
            {
                "service": service_name,
                "method": method,
                "url": url,
                "params": kwargs.get("params"),
                "data": kwargs.get("data"),
                "json": kwargs.get("json"),
                "status": response.status_code,
                "content_type": response.headers.get("content-type", ""),
                "body": response.json() if response.content else None,
            }
        )
        return response

    for module in (http, routing, weather, geocoding):
        module.request = recording  # type: ignore[attr-defined]
    # Replays start from a window with room, so the recording must not spend a request on the quota probe.
    room = {"X-RateLimit-Remaining": "600", "X-RateLimit-Reset": str(int(time.time()) + 60)}
    weather.QUOTA.note(httpx.Response(200, json={}, headers=room))
    now = datetime.now(UTC).replace(microsecond=0)
    service.plan(PlanIn(**payload), now=now)
    fixture = {"payload": payload, "now": now.isoformat(), "exchanges": exchanges}
    with gzip.open(Path(__file__).parent / name, "wt") as f:
        json.dump(fixture, f)
    print(name, [(e["service"], e["status"]) for e in exchanges])


if __name__ == "__main__":
    main(sys.argv[1], json.loads(sys.argv[2]))
