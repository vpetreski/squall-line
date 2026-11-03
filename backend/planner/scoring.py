"""Route summaries and the recommendation.

A route's exposure is the miles it spends at each risk level (each checkpoint contributes the road it stands for)
and the mile-weighted average level, 0 (Low) to 4 (No Travel). Routes are ranked by, in order:

1. fewest No Travel miles,
2. fewest Severe miles,
3. fewest High miles,
4. lowest average level,
5. shortest trip time.

Keys 2-5 are the stated preference order. Key 1 comes first because a route through No Travel weather cannot be
preferred to one without it, however the other keys compare. Miles are compared to a tenth of a mile and the
average to a hundredth, the precision both are shown at, so the reason given for a ranking is always visible in
the numbers shown. On a calm day every route is Low everywhere and the fastest one wins.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from .risk import Risk

KEYS = ("no_travel_miles", "severe_miles", "high_miles", "average_risk", "trip_time_s")


@dataclass(frozen=True, slots=True)
class Exposure:
    miles: tuple[float, float, float, float, float]
    average: float

    def at(self, level: Risk) -> float:
        return self.miles[level]


@dataclass(frozen=True, slots=True)
class Score:
    route_id: str
    exposure: Exposure
    trip_time_s: float

    @property
    def key(self) -> tuple[float, float, float, float, float]:
        e = self.exposure
        return (
            round(e.at(Risk.NO_TRAVEL), 1),
            round(e.at(Risk.SEVERE), 1),
            round(e.at(Risk.HIGH), 1),
            round(e.average, 2),
            round(self.trip_time_s),
        )


@dataclass(frozen=True, slots=True)
class Comparison:
    route_id: str
    key: str | None
    best: float | None
    other: float | None


@dataclass(frozen=True, slots=True)
class Hazard:
    level: Risk
    first: int
    last: int
    causes: tuple[str, ...]


def exposure(levels: Sequence[Risk], represents_mi: Sequence[float]) -> Exposure:
    miles = [0.0] * len(Risk)
    for level, mi in zip(levels, represents_mi, strict=True):
        miles[level] += mi
    total = sum(represents_mi)
    average = sum(int(level) * mi for level, mi in zip(levels, represents_mi, strict=True)) / total if total else 0.0
    return Exposure(miles=(miles[0], miles[1], miles[2], miles[3], miles[4]), average=average)


def rank(scores: Sequence[Score]) -> list[Score]:
    """Best first; ties keep the routing engine's order."""
    return sorted(scores, key=lambda s: s.key)


def compare(best: Score, other: Score) -> Comparison:
    """The first ranking key on which `best` beats `other`, or no key when they tie on all of them."""
    for name, b, o in zip(KEYS, best.key, other.key, strict=True):
        if b != o:
            return Comparison(route_id=other.route_id, key=name, best=b, other=o)
    return Comparison(route_id=other.route_id, key=None, best=None, other=None)


def hazards(levels: Sequence[Risk], causes: Sequence[tuple[str, ...]], minimum: Risk = Risk.HIGH) -> list[Hazard]:
    """Runs of consecutive checkpoints at `minimum` or worse, with the worst level and its causes."""
    out: list[Hazard] = []
    start: int | None = None
    for i, level in enumerate([*levels, Risk.LOW]):
        if level >= minimum and start is None:
            start = i
        elif level < minimum and start is not None:
            run = range(start, i)
            worst = max(levels[j] for j in run)
            named = sorted({c for j in run if levels[j] == worst for c in causes[j]})
            out.append(Hazard(level=worst, first=start, last=i - 1, causes=tuple(named)))
            start = None
    return out
