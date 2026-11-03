"""Hourly forecasts from Open-Meteo, and their values at the moment the truck passes.

Open-Meteo's `best_match` model for the contiguous US is NOAA's HRRR (3 km) for the first 48 hours, then GFS.
Its hourly fields come in two kinds, and they are read differently at an arrival time t:

* instantaneous fields (wind speed, temperature) are interpolated linearly between the hours around t, and the
  weather code, a category, is taken from the nearest hour;
* preceding-hour totals and maxima (rain, showers, snowfall, gusts) are read from the hour that contains t, which
  is stamped at the first full hour after t.

Rain is `rain + showers` (convective showers are a separate field). Snowfall is fresh snow depth, so with
`precipitation_unit=inch` it is inches of snow per hour, the unit of the rule table.

The free API charges every location against a quota per IP address (600 a minute, 5,000 an hour, 10,000 a day).
So a plan asks for a bounded set of locations (`plan_locations`), each location's series is cached for half an
hour (another load, interval or a later departure inside the same window costs nothing), and the quota headers of
every answer are kept. A request that the remaining quota cannot cover is not sent: Open-Meteo admits it and then
holds it until the quota refills. Instead, and whenever Open-Meteo refuses or does not answer in time, the plan is
answered with the exact query (`WeatherRelay`): the browser sends it to Open-Meteo from its own address and
returns the answer with the plan. The query asks for every location of the plan that the supplied answer does
not cover, cached in this process or not, because the browser's next attempt may reach another server process
with its own cache and quota: one round from the browser is enough unless that process finds other routes. An
answer supplied that way serves that one request and never enters the shared cache.
"""

from __future__ import annotations

import logging
import math
import threading
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import numpy as np
import numpy.typing as npt
from django.conf import settings
from django.core.cache import cache

from .http import UpstreamError, request

log = logging.getLogger(__name__)
FloatArray = npt.NDArray[np.float64]
Entry = tuple[int, FloatArray]  # (unix time of the first hour, values with shape (len(HOURLY), hours))

HOURLY = ("wind_speed_10m", "wind_gusts_10m", "rain", "showers", "snowfall", "temperature_2m", "weather_code")
INSTANT = ("wind_speed_10m", "temperature_2m")
PER_HOUR = ("wind_gusts_10m", "rain", "showers", "snowfall")
HOUR = 3600
CACHE_TTL_S = 30 * 60
CACHE_PREFIX = "wx2"
BATCH = 600  # locations per request; Open-Meteo accepts up to 1,000
TIMEOUT = httpx.Timeout(20.0, connect=5.0)
PROBE_TIMEOUT = httpx.Timeout(5.0, connect=3.0)
MAX_SUPPLIED = 1000


@dataclass(frozen=True, slots=True)
class Location:
    lat: float
    lon: float

    def key(self) -> str:
        return f"{self.lat:.4f},{self.lon:.4f}"


@dataclass(slots=True)
class Forecasts:
    """Hourly series for many locations on one shared time axis (unix seconds at the top of each hour)."""

    times: npt.NDArray[np.int64]
    fields: dict[str, FloatArray]  # name -> (locations, hours)

    def at(self, index: npt.ArrayLike, when: npt.ArrayLike) -> dict[str, FloatArray]:
        """Each field for location `index[k]` at unix time `when[k]`."""
        idx = np.asarray(index, dtype=np.int64)
        t = np.asarray(when, dtype=float)
        times = self.times.astype(float)
        last = len(times) - 1
        lo = np.clip(np.searchsorted(times, t, side="right") - 1, 0, last)
        hi = np.clip(lo + 1, 0, last)
        span = np.where(hi > lo, times[hi] - times[lo], 1.0)
        frac = np.clip((t - times[lo]) / span, 0.0, 1.0)
        bucket = np.clip(np.searchsorted(times, t, side="right"), 0, last)
        nearest = np.where(frac < 0.5, lo, hi)
        out: dict[str, FloatArray] = {}
        for name, grid in self.fields.items():
            if name in INSTANT:
                out[name] = grid[idx, lo] * (1 - frac) + grid[idx, hi] * frac
            elif name in PER_HOUR:
                out[name] = grid[idx, bucket]
            else:  # the weather code is a category: the nearest hour
                out[name] = grid[idx, nearest]
        return out


class Quota:
    """What Open-Meteo's answers said about this server's quota: what is left in the current window, and until when
    asking again is pointless."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._blocked_until = 0.0
        self._remaining: float | None = None
        self._reset = 0.0

    def blocked(self) -> bool:
        with self._lock:
            return time.time() < self._blocked_until

    def known(self) -> bool:
        """Whether the last answer's count still describes the current window."""
        with self._lock:
            return self._remaining is not None and time.time() < self._reset

    def covers(self, locations: int) -> bool:
        """Whether the current window has room for this many locations (unknown counts as room)."""
        with self._lock:
            if time.time() < self._blocked_until:
                return False
            if self._remaining is None or time.time() >= self._reset:
                return True
            return self._remaining >= locations

    def note(self, response: httpx.Response) -> None:
        now = time.time()
        reset = _number(response.headers.get("X-RateLimit-Reset"))
        remaining = _number(response.headers.get("X-RateLimit-Remaining"))
        if remaining is not None:
            with self._lock:
                self._remaining = remaining
                self._reset = reset if reset and reset > now else now + 60
        until = 0.0
        if response.status_code == 429:
            reason = _reason(response).lower()
            if "daily" in reason:
                until = now + 3600
            elif "hourly" in reason:
                until = now + 600
            else:
                until = reset if reset and reset > now else now + 60
        elif remaining is not None and remaining <= 0:
            until = reset if reset and reset > now else now + 60
        if until:
            with self._lock:
                self._blocked_until = max(self._blocked_until, until)

    def clear(self) -> None:
        with self._lock:
            self._blocked_until = 0.0
            self._remaining = None
            self._reset = 0.0


QUOTA = Quota()


class WeatherRelay(UpstreamError):
    """This server cannot fetch the forecast now; `query` is the request to send to Open-Meteo instead."""

    def __init__(self, code: str, message: str, locations: Sequence[Location], first: datetime, last: datetime):
        super().__init__("weather", message)
        self.code = code
        self.query = {
            "url": settings.OPEN_METEO_PUBLIC_URL,
            "form": _form(locations, first, last),
            "locations": [[loc.lat, loc.lon] for loc in locations],
        }


class _Refused(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def window(start: datetime, end: datetime) -> tuple[datetime, datetime]:
    """Whole hours covering [start, end], with an hour to spare on each side for interpolation."""
    first = start.astimezone(UTC).replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)
    last = end.astimezone(UTC).replace(minute=0, second=0, microsecond=0) + timedelta(hours=2)
    return first, last


def fetch(
    locations: Sequence[Location],
    start: datetime,
    end: datetime,
    supplied: Mapping[str, Entry] | None = None,
) -> tuple[Forecasts, dict[str, int]]:
    """Forecasts for every location between `start` and `end`: supplied, cached, or downloaded."""
    first, last = window(start, end)
    t_first, t_last = int(first.timestamp()), int(last.timestamp())
    hours = (t_last - t_first) // HOUR + 1
    keys = [_key(loc) for loc in locations]
    given = supplied or {}
    series = {k: given[k] for k in keys if k in given and _covers(given[k], t_first, t_last)}
    used_supplied = len(series)
    # A relay asks for all of these, cached here or not: the next attempt may reach a process with a cold cache.
    uncovered = list({k: loc for loc, k in zip(locations, keys, strict=True) if k not in series}.values())
    hits = cache.get_many([_key(loc) for loc in uncovered])
    series |= {k: entry for k, entry in hits.items() if _covers(entry, t_first, t_last)}
    from_cache = len(series) - used_supplied
    missing = [loc for loc in uncovered if _key(loc) not in series]
    calls = 0
    if missing:
        if not QUOTA.known() and not QUOTA.blocked():
            _probe()
        if not QUOTA.covers(len(missing)):
            raise WeatherRelay(
                "weather_rate_limited",
                "Open-Meteo's quota for this server cannot cover the plan",
                uncovered,
                first,
                last,
            )
        for i in range(0, len(missing), BATCH):
            try:
                fresh = _download(missing[i : i + BATCH], first, last)
            except _Refused as exc:
                raise WeatherRelay(exc.code, str(exc), uncovered, first, last) from exc
            calls += 1
            cache.set_many(fresh, CACHE_TTL_S)
            series.update(fresh)
    grid = np.stack([_slice(series[k], t_first, hours) for k in keys]) if keys else np.zeros((0, len(HOURLY), hours))
    gaps = [name for j, name in enumerate(HOURLY) if np.isnan(grid[:, j, :]).any()]
    if gaps:
        raise UpstreamError("weather", f"the forecast has gaps in {', '.join(gaps)}")
    times = (t_first + HOUR * np.arange(hours)).astype(np.int64)
    fields = {name: grid[:, j, :] for j, name in enumerate(HOURLY)}
    stats = {
        "locations": len(locations),
        "downloaded": len(missing),
        "cached": from_cache,
        "supplied": used_supplied,
        "requests": calls,
    }
    return Forecasts(times=times, fields=fields), stats


def supplied_series(locations: Sequence[Sequence[float]], response: Any) -> dict[str, Entry]:
    """Series from an Open-Meteo answer that the client fetched itself for the relayed `locations`."""
    if len(locations) > MAX_SUPPLIED:
        raise ValueError(f"at most {MAX_SUPPLIED} locations")
    places = [Location(round(float(lat), 4), round(float(lon), 4)) for lat, lon in locations]
    return parse(places, response)


def parse(locations: Sequence[Location], body: Any, t0: int | None = None) -> dict[str, Entry]:
    """Series per location from an Open-Meteo answer: one object for one location, otherwise a list in order."""
    items = body if isinstance(body, list) else [body]
    if len(items) != len(locations):
        raise ValueError(f"{len(items)} forecasts for {len(locations)} locations")
    out: dict[str, Entry] = {}
    for loc, item in zip(locations, items, strict=True):
        hourly = item.get("hourly") if isinstance(item, dict) else None
        if not isinstance(hourly, dict):
            raise ValueError("a forecast has no hourly data")
        try:
            times = np.asarray(hourly.get("time"), dtype=np.int64).reshape(-1)
            rows = [[_value(v) for v in _column(hourly, name, len(times))] for name in HOURLY]
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"a forecast is malformed ({exc})") from exc
        if len(times) == 0 or times[0] % HOUR or (np.diff(times) != HOUR).any():
            raise ValueError("forecast times are not consecutive whole hours")
        if t0 is not None and times[0] != t0:
            raise ValueError("the forecast starts at an unexpected hour")
        out[_key(loc)] = (int(times[0]), np.array(rows, dtype=float))
    return out


def _value(v: Any) -> float:
    """One hourly value: null is a gap in the forecast, anything else must be a finite number (JSON parsers turn
    1e999 into infinity)."""
    if v is None:
        return math.nan
    number = float(v)
    if not math.isfinite(number):
        raise ValueError(f"{v!r} is not a finite number")
    return number


def _column(hourly: dict, name: str, length: int) -> list:
    column = hourly.get(name)
    if not isinstance(column, list) or len(column) != length:
        raise ValueError(f"{name} is missing or the wrong length")
    return column


def _download(locations: Sequence[Location], first: datetime, last: datetime) -> dict[str, Entry]:
    form = _form(locations, first, last)
    if settings.OPEN_METEO_API_KEY:
        form["apikey"] = settings.OPEN_METEO_API_KEY
    started = time.perf_counter()
    try:
        response = request(
            "weather",
            "POST",
            settings.OPEN_METEO_URL,
            data=form,
            timeout=TIMEOUT,
            retries=1,
            retry_status=frozenset(),  # a refused or slow request is not retried: Open-Meteo queues and charges it
            retry_on=(httpx.ConnectError, httpx.ConnectTimeout),
        )
    except UpstreamError as exc:
        raise _Refused("weather_timeout" if exc.timeout else "weather_unavailable", str(exc)) from exc
    QUOTA.note(response)
    log.info(
        "weather: %d locations, HTTP %d, %.2f s, %d KB, quota left %s",
        len(locations),
        response.status_code,
        time.perf_counter() - started,
        len(response.content) // 1024,
        response.headers.get("X-RateLimit-Remaining", "?"),
    )
    if response.status_code == 429:
        raise _Refused("weather_rate_limited", f"Open-Meteo: {_reason(response) or 'quota exceeded'}")
    if response.status_code != 200:
        raise _Refused("weather_unavailable", f"Open-Meteo: {_reason(response) or f'HTTP {response.status_code}'}")
    try:
        return parse(locations, response.json(), int(first.timestamp()))
    except ValueError as exc:
        raise UpstreamError("weather", f"Open-Meteo answered with an unusable forecast: {exc}") from exc


def _probe() -> None:
    """Learn the quota left in this window from a one-location request, so a plan never waits on a held request."""
    params = {"latitude": "39.8", "longitude": "-98.6", "hourly": "temperature_2m", "forecast_hours": "1"}
    if settings.OPEN_METEO_API_KEY:
        params["apikey"] = settings.OPEN_METEO_API_KEY
    try:
        response = request("weather", "GET", settings.OPEN_METEO_URL, params=params, timeout=PROBE_TIMEOUT, retries=0)
    except UpstreamError as exc:
        log.warning("weather: quota probe failed: %s", exc)
        return
    QUOTA.note(response)


def _form(locations: Sequence[Location], first: datetime, last: datetime) -> dict[str, str]:
    return {
        "latitude": ",".join(f"{loc.lat:.4f}" for loc in locations),
        "longitude": ",".join(f"{loc.lon:.4f}" for loc in locations),
        "hourly": ",".join(HOURLY),
        "wind_speed_unit": "mph",
        "precipitation_unit": "inch",
        "temperature_unit": "fahrenheit",
        "timeformat": "unixtime",
        "timezone": "GMT",
        "start_hour": f"{first.astimezone(UTC):%Y-%m-%dT%H:%M}",
        "end_hour": f"{last.astimezone(UTC):%Y-%m-%dT%H:%M}",
    }


def _key(loc: Location) -> str:
    return f"{CACHE_PREFIX}:{loc.key()}"


def _covers(entry: Entry, first: int, last: int) -> bool:
    t0, values = entry
    return t0 <= first and t0 + HOUR * (values.shape[1] - 1) >= last


def _slice(entry: Entry, first: int, hours: int) -> FloatArray:
    t0, values = entry
    start = (first - t0) // HOUR
    return values[:, start : start + hours]


def _number(value: str | None) -> float | None:
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None


def _reason(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return ""
    return str(body.get("reason", "")) if isinstance(body, dict) else ""


@dataclass(frozen=True, slots=True)
class Sampling:
    locations: list[Location]
    index: list[int]  # for each requested point, its location
    snapped: int  # points read from a coarser grid than 0.01 degrees
    grid_deg: tuple[float, float]  # grid step used within the first 48 hours, and beyond


# (grid step in degrees for points within 48 hours, for points beyond), tried in order until the budget holds.
# HRRR is a 3 km grid for the first 48 hours, GFS about 13 km after that.
SNAP_STEPS = (
    (0.01, 0.01),
    (0.01, 0.125),
    (0.05, 0.25),
    (0.15, 0.5),
    (0.25, 0.5),
    (0.5, 0.5),
    (1.0, 1.0),
)


def plan_locations(points: Sequence[tuple[float, float, float]], budget: int) -> Sampling:
    """Unique forecast locations for (lat, lon, lead hours) points, within `budget` if the grid allows."""
    best: Sampling | None = None
    for near_step, far_step in SNAP_STEPS:
        keys: dict[tuple[float, float], int] = {}
        index: list[int] = []
        snapped = 0
        for lat, lon, lead_h in points:
            step = near_step if lead_h <= 48 else far_step
            if step > 0.01:
                snapped += 1
            key = (round(round(lat / step) * step, 4), round(round(lon / step) * step, 4))
            index.append(keys.setdefault(key, len(keys)))
        best = Sampling(
            locations=[Location(lat, lon) for lat, lon in keys],
            index=index,
            snapped=snapped,
            grid_deg=(near_step, far_step),
        )
        if len(keys) <= budget:
            break
    assert best is not None
    return best


def lead_hours(when: datetime, now: datetime | None = None) -> float:
    return ((when - (now or datetime.now(UTC))).total_seconds()) / HOUR
