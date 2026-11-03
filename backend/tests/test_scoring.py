import pytest

from planner.risk import Risk
from planner.scoring import Comparison, Score, compare, exposure, hazards, rank

L, M, H, S, N = Risk.LOW, Risk.MODERATE, Risk.HIGH, Risk.SEVERE, Risk.NO_TRAVEL


def score(route_id, levels, trip_h, each_mi=10.0):
    return Score(route_id=route_id, exposure=exposure(levels, [each_mi] * len(levels)), trip_time_s=trip_h * 3600)


def test_exposure_counts_miles_and_average():
    e = exposure([L, M, H, S], [10, 20, 30, 40])
    assert e.miles == (10, 20, 30, 40, 0)
    assert e.average == pytest.approx((0 * 10 + 1 * 20 + 2 * 30 + 3 * 40) / 100)


def test_fewest_severe_miles_wins_over_time():
    fast_but_severe = score("A", [L, S, L], 10)
    slow_but_high = score("B", [H, H, H], 14)
    assert [s.route_id for s in rank([fast_but_severe, slow_but_high])] == ["B", "A"]


def test_then_fewest_high_miles():
    a = score("A", [H, H, L], 10)
    b = score("B", [H, M, M], 12)
    assert rank([a, b])[0].route_id == "B"
    assert compare(b, a).key == "high_miles"


def test_then_average_then_time():
    a = score("A", [M, M, L], 10)
    b = score("B", [M, L, L], 12)
    c = score("C", [M, L, L], 11)
    assert [s.route_id for s in rank([a, b, c])] == ["C", "B", "A"]
    assert compare(c, b).key == "trip_time_s"
    assert compare(c, a).key == "average_risk"


def test_no_travel_is_never_preferred():
    severe = score("A", [S, S, S, S], 10)
    blocked = score("B", [L, L, L, N], 9)
    assert rank([blocked, severe])[0].route_id == "A"
    assert compare(severe, blocked).key == "no_travel_miles"


def test_ties_keep_engine_order_and_report_no_key():
    a = score("A", [L, L], 10)
    b = score("B", [L, L], 10)
    assert [s.route_id for s in rank([a, b])] == ["A", "B"]
    assert compare(a, b).key is None


def test_rounding_noise_does_not_decide():
    a = Score("A", exposure([S, L], [10.04, 10]), 11 * 3600)
    b = Score("B", exposure([S, L], [10.0, 10]), 10 * 3600)
    assert rank([a, b])[0].route_id == "B"  # 10.04 and 10.0 severe miles tie at 0.1 mi; B is faster


def test_trip_time_is_compared_to_the_minute_it_is_shown_at():
    a = score("A", [L, L], 10)
    b = Score("B", a.exposure, 10 * 3600 + 20)  # 20 s slower: both show as 10 h 00 m
    assert [s.route_id for s in rank([b, a])] == ["B", "A"]  # a tie keeps the order the routes came in
    assert compare(a, b) == Comparison("B", key=None, best=None, other=None)
    c = Score("C", a.exposure, 10 * 3600 + 30)  # half a minute rounds up, as the page does: 10 h 01 m
    assert compare(a, c) == Comparison("C", key="trip_time_s", best=36_000, other=36_060)


def test_hazards_are_runs_of_high_or_worse():
    levels = [L, H, S, H, L, L, N, L]
    causes = [(), ("wind",), ("snow",), ("wind",), (), (), ("wind",), ()]
    got = [(h.level, h.first, h.last, h.causes) for h in hazards(levels, causes)]
    assert got == [(S, 1, 3, ("snow",)), (N, 6, 6, ("wind",))]


def test_hazard_at_the_end_of_the_route():
    got = hazards([L, H, H], [(), ("rain",), ("rain", "wind")])
    assert [(h.first, h.last, h.causes) for h in got] == [(1, 2, ("rain", "wind"))]
