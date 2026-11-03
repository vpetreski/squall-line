import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from planner.risk import LOAD_RULES, RAIN, SNOW, WIND, Risk, assess, assess_levels, rules_table, wind_level

L, M, H, S, N = Risk.LOW, Risk.MODERATE, Risk.HIGH, Risk.SEVERE, Risk.NO_TRAVEL


@pytest.mark.parametrize(
    ("mph", "level"),
    [(0, L), (24.9, L), (25, M), (34.9, M), (35, H), (44.9, H), (45, S), (54.9, S), (55, N), (80, N)],
)
def test_wind_bands(mph, level):
    assert WIND.level(mph) == level


@pytest.mark.parametrize(
    ("in_hr", "level"),
    [(0, L), (0.099, L), (0.10, M), (0.249, M), (0.25, H), (0.499, H), (0.50, S), (1.00, S), (1.001, N)],
)
def test_rain_bands(in_hr, level):
    assert RAIN.level(in_hr) == level


@pytest.mark.parametrize(
    ("in_hr", "level"),
    [(0, L), (0.49, L), (0.5, M), (0.99, M), (1.0, H), (1.99, H), (2.0, S), (3.0, S), (3.01, N)],
)
def test_snow_bands(in_hr, level):
    assert SNOW.level(in_hr) == level


@pytest.mark.parametrize(
    ("mph", "load", "level", "rule"),
    [
        (55, 0, N, None),  # no travel for any load
        (60, 80_000, N, None),
        (45, 30_000, S, None),  # the load rule needs more than 30,000 lb
        (45, 30_001, N, "wind_45_over_30000_lb"),
        (54.9, 45_000, N, "wind_45_over_30000_lb"),
        (35, 40_000, H, None),
        (35, 40_001, S, "wind_35_over_40000_lb"),
        (44.9, 40_001, S, "wind_35_over_40000_lb"),
        (35, 35_000, H, None),  # over 30,000 lb only matters in the 45-54 band
        (34.9, 80_000, M, None),
        (24, 80_000, L, None),
    ],
)
def test_load_rules(mph, load, level, rule):
    got, applied = wind_level(mph, load)
    assert got == level
    assert (applied.code if applied else None) == rule


def test_a_raised_level_is_not_raised_again():
    # High becomes Severe for a 45,000 lb load; the Severe rule applies only to wind that was Severe to begin with.
    assert wind_level(40, 45_000)[0] == S
    assert assess_levels([40], [0], [0], 45_000).tolist() == [S]


def test_overall_level_is_the_worst_condition():
    a = assess(wind_mph=30, rain_in_hr=0.3, snow_in_hr=0.0, load_lb=10_000)
    assert (a.level, a.wind, a.rain, a.snow) == (H, M, H, L)
    assert a.causes == ("rain",)


def test_causes_name_every_condition_at_the_worst_level():
    a = assess(wind_mph=47, rain_in_hr=0.6, snow_in_hr=0.0, load_lb=20_000)
    assert a.level == S
    assert a.causes == ("wind", "rain")


def test_low_has_no_causes():
    assert assess(5, 0, 0, 0).causes == ()


def test_load_rule_is_reported():
    a = assess(48, 0, 0, 36_000)
    assert a.level == N
    assert a.load_rule is not None
    assert a.load_rule.code == "wind_45_over_30000_lb"


@given(
    wind=st.floats(0, 90, allow_nan=False),
    rain=st.floats(0, 2, allow_nan=False),
    snow=st.floats(0, 5, allow_nan=False),
    load=st.sampled_from([0, 30_000, 30_000.5, 40_000, 40_001, 80_000]),
)
def test_vectorized_matches_scalar(wind, rain, snow, load):
    assert assess_levels([wind], [rain], [snow], load)[0] == assess(wind, rain, snow, load).level


def test_vectorized_boundaries():
    wind = np.array([24.9, 25, 35, 45, 55])
    assert assess_levels(wind, np.zeros(5), np.zeros(5), 0).tolist() == [0, 1, 2, 3, 4]
    rain = np.array([0.099, 0.10, 0.25, 0.50, 1.00, 1.001])
    assert assess_levels(np.zeros(6), rain, np.zeros(6), 0).tolist() == [0, 1, 2, 3, 3, 4]


@pytest.mark.parametrize(
    ("wind", "rain", "snow", "level"),
    [
        (24.96, 0, 0, Risk.MODERATE),  # reported as 25.0 mph
        (54.96, 0, 0, Risk.NO_TRAVEL),  # reported as 55.0 mph
        (0, 0.07 + 0.03, 0, Risk.MODERATE),  # 0.09999999999999999 is the 0.100 it is shown as
        (0, 1.0004, 0, Risk.SEVERE),  # reported as 1.000: not above 1.00
        (0, 0, 2.9996, Risk.SEVERE),  # reported as 3.000: not above 3.0
    ],
)
def test_values_are_classified_as_reported(wind, rain, snow, level):
    assert assess(wind, rain, snow, 0).level == level
    assert assess_levels([wind], [rain], [snow], 0).tolist() == [level]


@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_missing_values_are_errors_not_low(bad):
    with pytest.raises(ValueError, match="missing"):
        assess(bad, 0, 0, 0)
    with pytest.raises(ValueError, match="missing"):
        assess_levels([0, bad], [0, 0], [0, 0], 0)


def test_rules_table_matches_the_code():
    table = rules_table()
    assert table["levels"] == ["low", "moderate", "high", "severe", "no_travel"]
    assert table["wind"] == {
        "unit": "mph",
        "moderate": 25,
        "high": 35,
        "severe": 45,
        "no_travel": 55,
        "no_travel_inclusive": True,
        "decimals": 1,
    }
    assert table["rain"]["no_travel_inclusive"] is False
    assert [r["code"] for r in table["load_rules"]] == [r.code for r in LOAD_RULES]
