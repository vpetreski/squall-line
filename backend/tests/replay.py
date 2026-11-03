"""Recorded upstream exchanges, replayed in order in place of `planner.http.request`."""

from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Any

import httpx

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> dict[str, Any]:
    """A fixture: the plan request, the moment it was made, and every exchange with the services it called."""
    with gzip.open(FIXTURES / f"{name}.json.gz", "rt") as f:
        return json.load(f)


def response(status: int, body: Any, headers: dict[str, str] | None = None) -> httpx.Response:
    content = b"" if body is None else json.dumps(body).encode()
    return httpx.Response(status, content=content, headers={"content-type": "application/json", **(headers or {})})


class Replay:
    """Answers each request with the next recorded exchange, after checking it is the request that was recorded."""

    def __init__(self, exchanges: list[dict[str, Any]]) -> None:
        self.exchanges = list(exchanges)
        self.calls: list[dict[str, Any]] = []

    def __call__(self, service: str, method: str, url: str, **kwargs: Any) -> httpx.Response:
        if not self.exchanges:
            raise AssertionError(f"unexpected {service} request: {method} {url}")
        recorded = self.exchanges.pop(0)
        assert (service, method, url) == (recorded["service"], recorded["method"], recorded["url"])
        self.calls.append({"service": service, "method": method, "url": url, **kwargs})
        headers = {"content-type": recorded.get("content_type") or "application/json", **recorded.get("headers", {})}
        return response(recorded["status"], recorded["body"], headers)
