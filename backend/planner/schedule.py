"""When the truck reaches each point of the route.

Driving time comes from the routing engine as cumulative times at maneuver points; between two of them it is
spread over the polyline in proportion to distance. Wall-clock time adds the federal hours-of-service stops for a
property-carrying driver (49 CFR 395.3), for a driver who starts the trip after 10 hours off duty:

* a 30-minute break once 8 hours of driving have passed without one;
* a 10-hour rest after 11 hours of driving, which starts the next shift (and also counts as the break).

With no other on-duty time, a shift is 8 h + 30 min + 3 h = 11.5 h, inside the 14-hour window, so the window never
binds. The 60/70-hour weekly limits are not modelled: the driver is assumed to have the hours available.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

import numpy as np
import numpy.typing as npt

FloatArray = npt.NDArray[np.float64]


@dataclass(frozen=True, slots=True)
class HoursOfService:
    break_after_s: float = 8 * 3600
    break_s: float = 30 * 60
    drive_limit_s: float = 11 * 3600
    rest_s: float = 10 * 3600

    @property
    def shift_s(self) -> float:
        """Wall-clock length of one full shift and the rest that follows it."""
        return self.drive_limit_s + self.break_s + self.rest_s


FMCSA = HoursOfService()


@dataclass(frozen=True, slots=True)
class Stop:
    kind: Literal["break", "rest"]
    drive_s: float
    start_s: float
    end_s: float


def drive_profile(cum_mi: FloatArray, index: Sequence[int], seconds: Sequence[float]) -> FloatArray:
    """Seconds of driving from the start to every vertex, from cumulative times known at some vertices.

    Between two anchors the time is spread in proportion to distance. Anchors come in route order with times that
    never decrease; where several fall on the same spot (a maneuver with no length), the latest time holds there.
    """
    idx = np.asarray(index, dtype=np.int64)
    t = np.asarray(seconds, dtype=float)
    if len(idx) == 0 or len(idx) != len(t):
        raise ValueError("drive-time anchors are missing")
    if idx[0] < 0 or idx[-1] >= len(cum_mi) or (np.diff(idx) < 0).any() or (np.diff(t) < 0).any():
        raise ValueError("drive-time anchors are out of route order")
    if not np.isfinite(t).all():
        raise ValueError("drive-time anchors are not numbers")
    x = cum_mi[idx]
    latest = np.r_[np.diff(x) > 0, True]
    x, t = x[latest], t[latest]
    if x[0] > 0:
        x, t = np.r_[0.0, x], np.r_[0.0, t]
    return np.asarray(np.interp(cum_mi, x, t), dtype=float)


def elapsed_s(drive_s: npt.ArrayLike, hos: HoursOfService | None) -> FloatArray:
    """Wall-clock seconds from departure until the truck has driven `drive_s` seconds.

    A point reached exactly at a limit is reached before the stop that the limit triggers.
    """
    d = np.asarray(drive_s, dtype=float)
    if hos is None:
        return d.copy()
    shift = np.maximum(np.ceil(d / hos.drive_limit_s) - 1, 0)
    within = d - shift * hos.drive_limit_s
    elapsed: FloatArray = shift * hos.shift_s + within + np.where(within > hos.break_after_s, hos.break_s, 0.0)
    return elapsed


def stops(total_drive_s: float, hos: HoursOfService | None) -> list[Stop]:
    """Breaks and rests the trip needs, in order."""
    if not math.isfinite(total_drive_s) or total_drive_s < 0:
        raise ValueError("the driving time must be a non-negative number")
    if hos is None:
        return []
    out: list[Stop] = []
    shift = 0
    while True:
        start = shift * hos.drive_limit_s
        for kind, at, length in (
            ("break", start + hos.break_after_s, hos.break_s),
            ("rest", start + hos.drive_limit_s, hos.rest_s),
        ):
            if total_drive_s <= at:
                return out
            begin = float(elapsed_s(at, hos))
            out.append(Stop(kind=kind, drive_s=at, start_s=begin, end_s=begin + length))  # type: ignore[arg-type]
        shift += 1


def timeline(
    cum_mi: FloatArray, cum_drive_s: FloatArray, hos: HoursOfService | None, step_mi: float = 5.0
) -> list[tuple[float, float]]:
    """(elapsed seconds, mile) pairs to place the truck at any moment of the trip.

    Linear interpolation between consecutive pairs is exact at the pairs; stops appear as two pairs at the
    same mile.
    """
    length = float(cum_mi[-1])
    miles = np.unique(np.concatenate([np.arange(0.0, length, step_mi), [length]]))
    drive = np.interp(miles, cum_mi, cum_drive_s)
    pairs = list(zip(elapsed_s(drive, hos).tolist(), miles.tolist(), strict=True))
    for stop in stops(float(cum_drive_s[-1]), hos):
        mile = float(np.interp(stop.drive_s, cum_drive_s, cum_mi))
        pairs += [(stop.start_s, mile), (stop.end_s, mile)]
    pairs.sort()
    return [(round(t, 1), round(m, 3)) for t, m in pairs]
