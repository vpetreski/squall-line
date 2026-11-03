import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from planner.schedule import FMCSA, drive_profile, elapsed_s, stops, timeline

H = 3600.0


@pytest.mark.parametrize(
    ("drive_h", "elapsed_h"),
    [
        (0, 0),
        (5, 5),
        (8, 8),  # reached exactly at the 8-hour mark: before the break
        (8.5, 9),  # 30-minute break after 8 h
        (11, 11.5),  # reached at the 11-hour limit: before the rest
        (11.25, 21.75),  # 10-hour rest, then the next shift
        (19, 29.5),  # 8 h into the second shift
        (19.5, 30.5),
        (22, 33),
        (22.5, 43.5),
    ],
)
def test_elapsed_with_hours_of_service(drive_h, elapsed_h):
    assert float(elapsed_s(drive_h * H, FMCSA)) == pytest.approx(elapsed_h * H)


def test_no_breaks_means_driving_time_only():
    assert elapsed_s([0, 30 * H], None).tolist() == [0, 30 * H]


def test_stops_for_a_two_day_drive():
    got = [(s.kind, s.drive_s / H, s.start_s / H, s.end_s / H) for s in stops(25 * H, FMCSA)]
    assert got == [
        ("break", 8, 8, 8.5),
        ("rest", 11, 11.5, 21.5),
        ("break", 19, 29.5, 30),
        ("rest", 22, 33, 43),
    ]


def test_short_trips_need_no_stops():
    assert stops(8 * H, FMCSA) == []
    assert [s.kind for s in stops(8.1 * H, FMCSA)] == ["break"]
    assert [s.kind for s in stops(11 * H, FMCSA)] == ["break"]
    assert stops(30 * H, None) == []


@given(st.lists(st.floats(0, 100 * H, allow_nan=False), min_size=2, max_size=30))
def test_elapsed_is_monotonic_and_never_less_than_driving(drives):
    d = np.sort(np.array(drives))
    e = elapsed_s(d, FMCSA)
    assert np.all(np.diff(e) >= -1e-6)
    assert np.all(e >= d - 1e-6)


def test_drive_profile_spreads_time_by_distance():
    cum = np.array([0.0, 1.0, 3.0, 4.0, 10.0])
    profile = drive_profile(cum, [0, 2, 4], [0, 300, 1000])
    assert profile.tolist() == pytest.approx([0, 100, 300, 400, 1000])


def test_drive_profile_keeps_the_latest_time_where_anchors_share_a_spot():
    # A maneuver with no length that takes time (a wait at a gate, say): the time after it holds there.
    cum = np.array([0.0, 2.0, 2.0, 4.0])
    profile = drive_profile(cum, [0, 1, 2, 3], [0, 100, 160, 260])
    assert profile.tolist() == pytest.approx([0, 160, 160, 260])


def test_drive_profile_starts_at_zero_when_the_first_anchor_is_further_on():
    cum = np.array([0.0, 1.0, 2.0])
    assert drive_profile(cum, [1, 2], [50, 100]).tolist() == pytest.approx([0, 50, 100])


@pytest.mark.parametrize(
    ("index", "seconds"),
    [
        ([], []),
        ([0, 2, 1], [0, 10, 20]),  # out of route order
        ([0, 1, 2], [0, 20, 10]),  # time going backwards
        ([0, 1, 5], [0, 10, 20]),  # beyond the polyline
        ([0, 1, 2], [0, float("nan"), 20]),
    ],
)
def test_drive_profile_rejects_inconsistent_anchors(index, seconds):
    with pytest.raises(ValueError, match="anchors"):
        drive_profile(np.array([0.0, 1.0, 2.0]), index, seconds)


@pytest.mark.parametrize("total", [float("nan"), float("inf"), -1.0])
def test_stops_rejects_a_driving_time_that_is_not_a_duration(total):
    with pytest.raises(ValueError, match="driving time"):
        stops(total, FMCSA)


def test_timeline_holds_the_truck_still_during_a_rest():
    cum_mi = np.array([0.0, 650.0, 1300.0])
    cum_s = np.array([0.0, 10 * H, 20 * H])  # 65 mph throughout
    pairs = timeline(cum_mi, cum_s, FMCSA, step_mi=50)
    rest_start, rest_end = 11.5 * H, 21.5 * H
    at_rest = [m for t, m in pairs if rest_start <= t <= rest_end]
    assert at_rest
    assert max(at_rest) - min(at_rest) == pytest.approx(0, abs=1e-6)
    assert at_rest[0] == pytest.approx(715.0)
    assert pairs[0] == (0.0, 0.0)
    assert pairs[-1][1] == pytest.approx(1300.0)
    times = [t for t, _ in pairs]
    assert times == sorted(times)
