"""One HTTP client for every upstream service: timeouts, a polite pace per host, a retry for transient failures."""

from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from collections.abc import Callable
from typing import Any

import httpx
from django.conf import settings
from django.core.cache import cache

log = logging.getLogger(__name__)

RETRY_STATUS = frozenset({429, 500, 502, 503, 504})


class UpstreamError(Exception):
    """An upstream service failed or refused; `service` names it for the error response."""

    def __init__(self, service: str, message: str, status: int | None = None, *, timeout: bool = False) -> None:
        super().__init__(message)
        self.service = service
        self.status = status
        self.timeout = timeout


class Pace:
    """At most one request per `interval_s` to a host, across threads (public servers ask for one per second)."""

    def __init__(self, interval_s: float) -> None:
        self.interval_s = interval_s
        self._next = 0.0
        self._lock = threading.Lock()

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            start = max(now, self._next)
            self._next = start + self.interval_s
        if start > now:
            time.sleep(start - now)


_client: httpx.Client | None = None
_client_lock = threading.Lock()


def client() -> httpx.Client:
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = httpx.Client(
                    timeout=httpx.Timeout(25.0, connect=6.0),
                    headers={"User-Agent": settings.HTTP_USER_AGENT, "Accept-Encoding": "gzip"},
                    limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
                )
    return _client


def request(
    service: str,
    method: str,
    url: str,
    *,
    pace: Pace | None = None,
    retries: int = 1,
    retry_status: frozenset[int] = RETRY_STATUS,
    retry_on: tuple[type[httpx.TransportError], ...] = (httpx.TransportError,),
    **kwargs: Any,
) -> httpx.Response:
    """Send a request, retrying `retries` times on the transport errors and answers named."""
    for attempt in range(retries + 1):
        if pace:
            pace.wait()
        try:
            response = client().request(method, url, **kwargs)
        except httpx.TransportError as exc:
            log.warning("%s: %s (attempt %d)", service, exc.__class__.__name__, attempt + 1)
            if attempt < retries and isinstance(exc, retry_on):
                time.sleep(1.0 + attempt)
                continue
            timeout = isinstance(exc, httpx.TimeoutException)
            message = f"{service} did not answer in time" if timeout else f"{service} could not be reached"
            raise UpstreamError(service, message, timeout=timeout) from exc
        if response.status_code in retry_status and attempt < retries:
            log.warning("%s: HTTP %d (attempt %d)", service, response.status_code, attempt + 1)
            time.sleep(_retry_after(response, attempt))
            continue
        return response
    raise AssertionError("unreachable")


def _retry_after(response: httpx.Response, attempt: int) -> float:
    try:
        return min(float(response.headers.get("Retry-After", "")), 5.0)
    except ValueError:
        return 1.5 * (attempt + 1)


def cache_key(prefix: str, *parts: object) -> str:
    digest = hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:32]
    return f"{prefix}:{digest}"


def cached[T](key: str, ttl_s: int | Callable[[T], int], compute: Callable[[], T]) -> tuple[T, bool]:
    """The cached value for `key`, computing and storing it on a miss; the flag says whether it was a hit.

    `ttl_s` is the lifetime in seconds, or a function that gives it for the value just computed.
    """
    hit = cache.get(key)
    if hit is not None:
        return hit, True
    value = compute()
    cache.set(key, value, ttl_s(value) if callable(ttl_s) else ttl_s)
    return value, False
