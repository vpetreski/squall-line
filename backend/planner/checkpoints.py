"""Where along a route the weather is sampled.

Checkpoints sit every `interval` miles from the origin, and the destination is always one. A regular mark closer
to the destination than a tenth of the interval is dropped in favour of the destination, so the last stretch is
never a sliver. Each checkpoint stands for the road halfway to its neighbours: the represented miles of all
checkpoints add up to the route length, which is what turns sampled levels into "miles at each level".
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from .geo import points_at
from .schedule import HoursOfService, elapsed_s

FloatArray = npt.NDArray[np.float64]

INTERVALS_MI = (10, 25, 50)


@dataclass(frozen=True, slots=True)
class Checkpoint:
    mile: float
    lat: float
    lon: float
    drive_s: float
    elapsed_s: float
    represents_mi: float


def checkpoint_miles(length_mi: float, interval_mi: float) -> FloatArray:
    if length_mi <= 0:
        return np.zeros(1)
    marks = np.arange(0.0, length_mi, interval_mi)
    if length_mi - marks[-1] < interval_mi / 10 and len(marks) > 1:
        marks = marks[:-1]
    return np.append(marks, length_mi)


def represented_miles(marks: FloatArray) -> FloatArray:
    """Length of road each mark stands for: from the midpoint before it to the midpoint after it."""
    if len(marks) == 1:
        return np.zeros(1)
    mids = (marks[:-1] + marks[1:]) / 2
    edges = np.concatenate([[marks[0]], mids, [marks[-1]]])
    return np.diff(edges)


def place(
    points: FloatArray,
    cum_mi: FloatArray,
    cum_drive_s: FloatArray,
    interval_mi: float,
    hos: HoursOfService | None,
) -> list[Checkpoint]:
    marks = checkpoint_miles(float(cum_mi[-1]), interval_mi)
    where = points_at(points, cum_mi, marks)
    drive = np.interp(marks, cum_mi, cum_drive_s)
    elapsed = elapsed_s(drive, hos)
    weights = represented_miles(marks)
    return [
        Checkpoint(
            mile=float(m),
            lat=float(p[0]),
            lon=float(p[1]),
            drive_s=float(d),
            elapsed_s=float(e),
            represents_mi=float(w),
        )
        for m, p, d, e, w in zip(marks, where, drive, elapsed, weights, strict=True)
    ]
