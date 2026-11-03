"""Weather risk for a loaded truck at one place and time.

Each condition has its own scale and the worst one sets the overall level. Every band includes its lower
bound (25 mph is Moderate, 0.25 in/hr of rain is High). The No Travel bounds are kept exactly as the rule
table writes them: wind at or above 55 mph, rain above 1.00 in/hr, snow above 3.0 in/hr. So 1.00 in/hr of
rain is still Severe, while 55 mph of wind is already No Travel.

Values are classified at the precision they are reported in (0.1 mph, 0.001 in/hr), so a rain total that adds
up to 0.09999999 is the 0.10 it is shown as. A missing value is an error, never Low.

Load rules raise the wind level for heavy trucks:

* 45-54 mph with more than 30,000 lb on board is No Travel (instead of Severe);
* 35-44 mph with more than 40,000 lb on board is Severe (instead of High).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from enum import IntEnum

import numpy as np
import numpy.typing as npt


class Risk(IntEnum):
    LOW = 0
    MODERATE = 1
    HIGH = 2
    SEVERE = 3
    NO_TRAVEL = 4

    @property
    def key(self) -> str:
        return self.name.lower()

    @property
    def label(self) -> str:
        return self.name.replace("_", " ").title()


@dataclass(frozen=True, slots=True)
class Scale:
    """Lower bounds of Moderate, High and Severe, and the No Travel bound."""

    moderate: float
    high: float
    severe: float
    no_travel: float
    no_travel_inclusive: bool
    unit: str
    decimals: int

    def level(self, value: float) -> Risk:
        if not math.isfinite(value):
            raise ValueError(f"cannot classify a missing value ({self.unit})")
        value = round(value, self.decimals)
        if value > self.no_travel or (self.no_travel_inclusive and value == self.no_travel):
            return Risk.NO_TRAVEL
        if value >= self.severe:
            return Risk.SEVERE
        if value >= self.high:
            return Risk.HIGH
        if value >= self.moderate:
            return Risk.MODERATE
        return Risk.LOW

    def levels(self, values: npt.ArrayLike) -> npt.NDArray[np.int8]:
        v = np.asarray(values, dtype=float)
        if not np.isfinite(v).all():
            raise ValueError(f"cannot classify missing values ({self.unit})")
        v = np.round(v, self.decimals)
        no_travel = (v >= self.no_travel) if self.no_travel_inclusive else (v > self.no_travel)
        out = np.select(
            [no_travel, v >= self.severe, v >= self.high, v >= self.moderate],
            [Risk.NO_TRAVEL, Risk.SEVERE, Risk.HIGH, Risk.MODERATE],
            default=Risk.LOW,
        )
        return out.astype(np.int8)


WIND = Scale(moderate=25, high=35, severe=45, no_travel=55, no_travel_inclusive=True, unit="mph", decimals=1)
RAIN = Scale(moderate=0.10, high=0.25, severe=0.50, no_travel=1.00, no_travel_inclusive=False, unit="in/hr", decimals=3)
SNOW = Scale(moderate=0.5, high=1.0, severe=2.0, no_travel=3.0, no_travel_inclusive=False, unit="in/hr", decimals=3)


@dataclass(frozen=True, slots=True)
class LoadRule:
    """Wind at `level` becomes `raised_to` when the load is heavier than `over_lb`."""

    code: str
    level: Risk
    over_lb: float
    raised_to: Risk


LOAD_RULES = (
    LoadRule(code="wind_45_over_30000_lb", level=Risk.SEVERE, over_lb=30_000, raised_to=Risk.NO_TRAVEL),
    LoadRule(code="wind_35_over_40000_lb", level=Risk.HIGH, over_lb=40_000, raised_to=Risk.SEVERE),
)


@dataclass(frozen=True, slots=True)
class Assessment:
    level: Risk
    wind: Risk
    rain: Risk
    snow: Risk
    load_rule: LoadRule | None = None

    @property
    def causes(self) -> tuple[str, ...]:
        """The conditions that set the overall level; empty when it is Low."""
        if self.level == Risk.LOW:
            return ()
        named = (("wind", self.wind), ("rain", self.rain), ("snow", self.snow))
        return tuple(name for name, level in named if level == self.level)


def wind_level(wind_mph: float, load_lb: float) -> tuple[Risk, LoadRule | None]:
    level = WIND.level(wind_mph)
    for rule in LOAD_RULES:
        if level == rule.level and load_lb > rule.over_lb:
            return rule.raised_to, rule
    return level, None


def assess(wind_mph: float, rain_in_hr: float, snow_in_hr: float, load_lb: float) -> Assessment:
    wind, rule = wind_level(wind_mph, load_lb)
    rain = RAIN.level(rain_in_hr)
    snow = SNOW.level(snow_in_hr)
    return Assessment(level=max(wind, rain, snow), wind=wind, rain=rain, snow=snow, load_rule=rule)


def assess_levels(
    wind_mph: npt.ArrayLike, rain_in_hr: npt.ArrayLike, snow_in_hr: npt.ArrayLike, load_lb: float
) -> npt.NDArray[np.int8]:
    """Overall level for whole arrays at once (the heatmap); same rules as `assess`."""
    base = WIND.levels(wind_mph)
    wind = base.copy()
    for rule in LOAD_RULES:
        if load_lb > rule.over_lb:
            wind[base == rule.level] = rule.raised_to
    return np.maximum(np.maximum(wind, RAIN.levels(rain_in_hr)), SNOW.levels(snow_in_hr)).astype(np.int8)


def rules_table() -> dict[str, object]:
    """The rule set as data, so the client draws its legend from the same numbers."""

    def scale(s: Scale) -> dict[str, object]:
        return {
            "unit": s.unit,
            "moderate": s.moderate,
            "high": s.high,
            "severe": s.severe,
            "no_travel": s.no_travel,
            "no_travel_inclusive": s.no_travel_inclusive,
            "decimals": s.decimals,
        }

    return {
        "levels": [level.key for level in Risk],
        "wind": scale(WIND),
        "rain": scale(RAIN),
        "snow": scale(SNOW),
        "load_rules": [
            {"code": r.code, "level": r.level.key, "over_lb": r.over_lb, "raised_to": r.raised_to.key}
            for r in LOAD_RULES
        ],
    }
