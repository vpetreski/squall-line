from __future__ import annotations

import httpx
import pytest
import respx

from planner import http

URL = "https://upstream.test/v1"


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    slept: list[float] = []
    monkeypatch.setattr(http.time, "sleep", slept.append)
    return slept


@respx.mock
def test_a_transient_answer_is_retried_once(sleeps):
    route = respx.get(URL).mock(side_effect=[httpx.Response(503), httpx.Response(200, json={"ok": True})])
    assert http.request("svc", "GET", URL).json() == {"ok": True}
    assert route.call_count == 2
    assert len(sleeps) == 1


@respx.mock
def test_retry_after_is_honoured_up_to_five_seconds(sleeps):
    respx.get(URL).mock(side_effect=[httpx.Response(429, headers={"Retry-After": "30"}), httpx.Response(200)])
    http.request("svc", "GET", URL)
    assert sleeps == [5.0]


@respx.mock
def test_answers_outside_the_retry_set_come_back_as_they_are(sleeps):
    route = respx.post(URL).mock(return_value=httpx.Response(429))
    assert http.request("svc", "POST", URL, retry_status=frozenset()).status_code == 429
    assert route.call_count == 1
    assert sleeps == []


@respx.mock
def test_an_unreachable_service_is_an_upstream_error_after_the_retry(sleeps):
    route = respx.get(URL).mock(side_effect=httpx.ConnectError("refused"))
    with pytest.raises(http.UpstreamError, match="could not be reached") as failed:
        http.request("svc", "GET", URL)
    assert route.call_count == 2
    assert not failed.value.timeout


@respx.mock
def test_a_timeout_is_not_retried_when_only_connection_errors_are(sleeps):
    route = respx.get(URL).mock(side_effect=httpx.ReadTimeout("slow"))
    with pytest.raises(http.UpstreamError, match="did not answer in time") as failed:
        http.request("svc", "GET", URL, retry_on=(httpx.ConnectError,))
    assert route.call_count == 1
    assert failed.value.timeout


def test_pace_spaces_requests(monkeypatch, sleeps):
    clock = iter([100.0, 100.2])
    monkeypatch.setattr(http.time, "monotonic", lambda: next(clock))
    pace = http.Pace(1.0)
    pace.wait()
    pace.wait()
    assert sleeps == [pytest.approx(0.8)]


def test_cached_computes_once():
    calls: list[int] = []

    def compute() -> int:
        calls.append(1)
        return 42

    key = http.cache_key("test", 1, "a")
    assert http.cached(key, 60, compute) == (42, False)
    assert http.cached(key, 60, compute) == (42, True)
    assert calls == [1]
    assert http.cache_key("test", 1, "a") == key != http.cache_key("test", 2, "a")


def test_one_client_is_shared():
    assert http.client() is http.client()
    assert "squall-line" in http.client().headers["User-Agent"]
