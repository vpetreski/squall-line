from __future__ import annotations

from datetime import UTC, datetime

import httpx
import numpy as np
import pytest
from django.core.cache import cache

from planner import weather
from planner.geo import cumulative_miles, points_at
from planner.weather import HOURLY, Forecasts, Location, parse, plan_locations, window

T0 = 1_793_725_200  # 2026-11-03 17:00 UTC
H = 3600


def grid(**columns: list[float]) -> Forecasts:
    hours = len(next(iter(columns.values())))
    fields = {name: np.zeros((1, hours)) for name in HOURLY}
    for name, values in columns.items():
        fields[name] = np.array([values], dtype=float)
    return Forecasts(times=(T0 + H * np.arange(hours)).astype(np.int64), fields=fields)


def test_instantaneous_fields_are_interpolated_between_hours():
    f = grid(wind_speed_10m=[10, 20, 40], temperature_2m=[30, 32, 40])
    at = f.at([0, 0, 0, 0], [T0, T0 + 1800, T0 + H, T0 + 1.5 * H])
    assert at["wind_speed_10m"].tolist() == pytest.approx([10, 15, 20, 30])
    assert at["temperature_2m"].tolist() == pytest.approx([30, 31, 32, 36])


def test_preceding_hour_fields_come_from_the_hour_that_contains_the_moment():
    # The value stamped at an hour is the total (or maximum) of the hour before it.
    f = grid(rain=[0.0, 0.3, 0.7], snowfall=[0.0, 0.5, 1.5], wind_gusts_10m=[0, 30, 50])
    at = f.at([0, 0, 0], [T0 + 1, T0 + H - 1, T0 + H])
    assert at["rain"].tolist() == [0.3, 0.3, 0.7]
    assert at["snowfall"].tolist() == [0.5, 0.5, 1.5]
    assert at["wind_gusts_10m"].tolist() == [30, 30, 50]


def test_the_weather_code_is_the_nearest_hour_never_a_blend():
    f = grid(weather_code=[3, 61, 71])
    at = f.at([0, 0, 0], [T0 + 1700, T0 + 1900, T0 + 2 * H + 100])
    assert at["weather_code"].tolist() == [3, 61, 71]


def test_the_window_covers_whole_hours_with_a_spare_hour_each_side():
    first, last = window(datetime(2026, 11, 3, 8, 20, tzinfo=UTC), datetime(2026, 11, 3, 20, 10, tzinfo=UTC))
    assert (first.hour, last.hour) == (7, 22)


def _cross_country(routes: int = 3, every_mi: float = 10.0, mph: float = 50.0) -> list[tuple[float, float, float]]:
    """Checkpoints of three New York - Los Angeles routes, the way a 10-mile interval places them."""
    out = []
    for k in range(routes):
        t = np.linspace(0, 1, 400)
        lat = 40.71 + (34.05 - 40.71) * t + (k - 1) * 1.2 * np.sin(np.pi * t)
        lon = -74.0 + (-118.24 + 74.0) * t
        pts = np.column_stack([lat, lon])
        cum = cumulative_miles(pts)
        marks = np.arange(0, cum[-1], every_mi)
        for mile, (a, b) in zip(marks, points_at(pts, cum, marks), strict=True):
            out.append((float(a), float(b), mile / mph))
    return out


def test_a_cross_country_plan_at_ten_miles_fits_the_budget():
    points = _cross_country()
    assert len(points) > 700
    sampling = plan_locations(points, 330)
    assert len(sampling.locations) <= 330
    assert sampling.grid_deg[0] > 0.01
    assert sampling.snapped == len(points)  # every point is within 48 hours, so all of them moved
    assert len(sampling.index) == len(points)
    assert max(sampling.index) == len(sampling.locations) - 1


def test_points_keep_their_own_spot_when_the_budget_allows():
    points = _cross_country(routes=1, every_mi=50)
    sampling = plan_locations(points, 2000)
    assert sampling.grid_deg == (0.01, 0.01)
    assert sampling.snapped == 0


def test_far_points_are_snapped_before_near_ones():
    near = [(40.0 + i * 0.02, -100.0, 10.0) for i in range(50)]
    far = [(35.0 + i * 0.02, -90.0, 60.0) for i in range(50)]
    sampling = plan_locations(near + far, 70)
    assert sampling.grid_deg == (0.01, 0.125)
    assert sampling.snapped == 50
    assert len({sampling.index[i] for i in range(50)}) == 50  # near points untouched


def _answer(times: list[int], **values: list[float | None]) -> dict:
    hourly = {"time": times} | {name: values.get(name, [0.0] * len(times)) for name in HOURLY}
    return {"latitude": 40.0, "longitude": -100.0, "hourly": hourly}


def test_parse_reads_one_object_or_a_list():
    times = [T0, T0 + H]
    one = parse([Location(40, -100)], _answer(times, wind_speed_10m=[5, 6]))
    t0, values = one["wx2:40.0000,-100.0000"]
    assert t0 == T0
    assert values.shape == (len(HOURLY), 2)
    assert values[HOURLY.index("wind_speed_10m")].tolist() == [5, 6]
    two = parse([Location(40, -100), Location(41, -100)], [_answer(times), _answer(times)])
    assert len(two) == 2


@pytest.mark.parametrize(
    ("locations", "body", "message"),
    [
        (2, [_answer([T0])], "1 forecasts for 2 locations"),
        (1, [{"latitude": 1}], "no hourly data"),
        (1, [_answer([T0, T0 + 2 * H])], "consecutive whole hours"),
        (1, [_answer([T0 + 60, T0 + H + 60])], "consecutive whole hours"),
        (1, [_answer([T0], rain=[0.1, 0.2])], "rain is missing or the wrong length"),
        (1, [_answer([T0], rain=["heavy"])], "malformed"),
        (1, [_answer([])], "consecutive whole hours"),
    ],
)
def test_parse_rejects_answers_that_do_not_fit(locations, body, message):
    with pytest.raises(ValueError, match=message):
        parse([Location(40 + i, -100) for i in range(locations)], body)


def test_nulls_become_gaps_and_gaps_are_an_error(settings, monkeypatch):
    loc = Location(40.0, -100.0)
    start = datetime.fromtimestamp(T0 + H, UTC)
    first, last = window(start, start)
    hours = (int(last.timestamp()) - int(first.timestamp())) // H + 1
    times = [int(first.timestamp()) + H * i for i in range(hours)]
    rain: list[float | None] = [0.0] * hours
    rain[2] = None
    entry = parse([loc], _answer(times, rain=rain))
    with pytest.raises(weather.UpstreamError, match="gaps in rain"):
        weather.fetch([loc], start, start, supplied=entry)


def test_cached_series_serve_any_window_they_cover(monkeypatch):
    loc = Location(40.0, -100.0)
    start = datetime.fromtimestamp(T0 + 5 * H, UTC)
    first, _ = window(start, start)
    times = [int(first.timestamp()) - 3 * H + H * i for i in range(30)]  # starts earlier, ends later
    cache.set_many(parse([loc], _answer(times, wind_speed_10m=list(range(30)))), 600)
    monkeypatch.setattr(weather, "request", lambda *a, **k: pytest.fail("no download expected"))
    forecasts, stats = weather.fetch([loc], start, start)
    assert stats == {"locations": 1, "downloaded": 0, "cached": 1, "supplied": 0, "requests": 0}
    assert forecasts.times[0] == int(first.timestamp())
    assert forecasts.fields["wind_speed_10m"][0, 0] == 3  # the slice starts at the window, not the cached start


def _open_meteo(sent: list[dict], remaining: str = "500"):
    """A stand-in for Open-Meteo: answers the probe and the forecast POST, and records both."""

    def answer(service, method, url, **kwargs):
        headers = {
            "X-RateLimit-Remaining": remaining,
            "X-RateLimit-Reset": str(int(datetime.now(UTC).timestamp()) + 60),
        }
        if method == "GET":
            sent.append({"probe": kwargs["params"]})
            return httpx.Response(200, json={}, headers=headers)
        form = kwargs["data"]
        sent.append(form)
        first = datetime.fromisoformat(form["start_hour"]).replace(tzinfo=UTC)
        last = datetime.fromisoformat(form["end_hour"]).replace(tzinfo=UTC)
        hours = int((last - first).total_seconds() // H) + 1
        times = [int(first.timestamp()) + H * i for i in range(hours)]
        count = len(form["latitude"].split(","))
        body = [_answer(times) for _ in range(count)]
        return httpx.Response(200, json=body if count > 1 else body[0], headers=headers)

    return answer


def test_a_download_asks_for_the_window_only_and_never_hands_the_key_to_a_browser(settings, monkeypatch):
    settings.OPEN_METEO_API_KEY = "server-only"
    start = datetime.fromtimestamp(T0, UTC)
    sent: list[dict] = []
    monkeypatch.setattr(weather, "request", _open_meteo(sent))
    _, stats = weather.fetch([Location(40.0, -100.0)], start, start)
    probe, form = sent
    assert "probe" in probe  # the quota was unknown: one cheap request learned it first
    assert stats["downloaded"] == 1
    assert form["apikey"] == "server-only"
    first, last = window(start, start)
    assert (form["start_hour"], form["end_hour"]) == (f"{first:%Y-%m-%dT%H:%M}", f"{last:%Y-%m-%dT%H:%M}")

    weather.QUOTA.note(httpx.Response(429, json={"reason": "Minutely API request limit exceeded."}))
    with pytest.raises(weather.WeatherRelay) as relayed:
        weather.fetch([Location(41.0, -100.0)], start, start)
    assert "apikey" not in relayed.value.query["form"]
    assert relayed.value.query["locations"] == [[41.0, -100.0]]


def test_a_plan_the_quota_cannot_cover_is_relayed_without_asking(monkeypatch):
    start = datetime.fromtimestamp(T0, UTC)
    sent: list[dict] = []
    monkeypatch.setattr(weather, "request", _open_meteo(sent, remaining="40"))
    many = [Location(40.0 + i * 0.01, -100.0) for i in range(41)]
    with pytest.raises(weather.WeatherRelay) as relayed:
        weather.fetch(many, start, start)
    assert relayed.value.code == "weather_rate_limited"
    assert [list(m) for m in sent] == [["probe"]]  # Open-Meteo would hold a request it cannot cover
    forty = many[:40]
    weather.fetch(forty, start, start)  # room for exactly these: sent, and no second probe
    assert len(sent) == 2
    assert len(sent[1]["latitude"].split(",")) == 40


def _browser_fetch(relay: dict) -> dict[str, weather.Entry]:
    """What the browser brings back for a relayed query: Open-Meteo's answer, read as a supplied forecast."""
    answer = _open_meteo([])("weather", "POST", relay["url"], data=relay["form"]).json()
    return weather.supplied_series(relay["locations"], answer)


def test_a_relay_asks_for_every_location_not_supplied_even_those_cached_here(monkeypatch):
    start = datetime.fromtimestamp(T0, UTC)
    monkeypatch.setattr(weather, "request", _open_meteo([]))
    warm, cold = Location(40.0, -100.0), Location(41.0, -100.0)
    weather.fetch([warm], start, start)  # this process now has `warm` cached
    weather.QUOTA.note(httpx.Response(429, json={"reason": "Minutely API request limit exceeded."}))
    with pytest.raises(weather.WeatherRelay) as relayed:
        weather.fetch([warm, cold], start, start)
    relay = relayed.value.query
    assert relay["locations"] == [[40.0, -100.0], [41.0, -100.0]]

    # The browser's next attempt reaches another process: nothing cached there, and its quota spent too.
    cache.clear()
    monkeypatch.setattr(weather, "request", lambda *a, **k: pytest.fail("no request expected"))
    _, stats = weather.fetch([warm, cold], start, start, supplied=_browser_fetch(relay))
    assert stats == {"locations": 2, "downloaded": 0, "cached": 0, "supplied": 2, "requests": 0}


def test_a_refused_second_batch_relays_the_first_batch_too(monkeypatch):
    monkeypatch.setattr(weather, "BATCH", 1)
    start = datetime.fromtimestamp(T0, UTC)
    sent: list[dict] = []
    open_meteo = _open_meteo(sent)

    def refuse_the_second_batch(service, method, url, **kwargs):
        if method == "POST" and sum("probe" not in m for m in sent) == 1:
            return httpx.Response(429, json={"reason": "Minutely API request limit exceeded."})
        return open_meteo(service, method, url, **kwargs)

    monkeypatch.setattr(weather, "request", refuse_the_second_batch)
    both = [Location(40.0, -100.0), Location(41.0, -100.0)]
    with pytest.raises(weather.WeatherRelay) as relayed:
        weather.fetch(both, start, start)
    relay = relayed.value.query
    assert relay["locations"] == [[40.0, -100.0], [41.0, -100.0]]
    cache.clear()
    _, stats = weather.fetch(both, start, start, supplied=_browser_fetch(relay))
    assert stats["supplied"] == 2


@pytest.mark.parametrize(
    ("status", "headers", "reason", "blocked_s"),
    [
        (429, {}, "Minutely API request limit exceeded. Please try again in one minute.", 60),
        (429, {}, "Hourly API request limit exceeded. Please try again in the next hour.", 600),
        (429, {}, "Daily API request limit exceeded. Please try again tomorrow.", 3600),
        (200, {"X-RateLimit-Remaining": "-3.0"}, "", 60),
        (200, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "{reset}"}, "", 30),
    ],
)
def test_quota_reads_refusals_and_headers(status, headers, reason, blocked_s, monkeypatch):
    now = 2_000_000_000.0
    monkeypatch.setattr(weather.time, "time", lambda: now)
    headers = {k: v.format(reset=int(now + 30)) for k, v in headers.items()}
    weather.QUOTA.note(httpx.Response(status, json={"reason": reason} if reason else {}, headers=headers))
    assert weather.QUOTA.blocked()
    monkeypatch.setattr(weather.time, "time", lambda: now + blocked_s + 1)
    assert not weather.QUOTA.blocked()


def test_quota_with_room_left_does_not_block():
    weather.QUOTA.note(httpx.Response(200, json={}, headers={"X-RateLimit-Remaining": "120.0"}))
    assert not weather.QUOTA.blocked()


def test_supplied_series_rounds_locations_and_caps_their_number():
    times = [T0, T0 + H]
    got = weather.supplied_series([[40.00001, -100.00004]], _answer(times))
    assert list(got) == ["wx2:40.0000,-100.0000"]
    with pytest.raises(ValueError, match="at most"):
        weather.supplied_series([[40, -100]] * (weather.MAX_SUPPLIED + 1), [])


def test_lead_hours():
    now = datetime(2026, 11, 3, 12, tzinfo=UTC)
    assert weather.lead_hours(datetime(2026, 11, 4, 0, tzinfo=UTC), now) == 12
