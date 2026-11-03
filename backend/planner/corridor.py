"""The weather heatmap along the trip corridor.

The corridor is everything within W of any route, where W is 4% of the longest route, kept between 30 and 90 km.
It is covered by a regular grid in Web Mercator, the projection the map is drawn in, so the client can lay the whole
grid on the map as one image by its four corners. The cell size is chosen so that between 85% of `budget` and
`budget` cells fall inside the corridor; each of those is one forecast location. Frames are hourly from departure,
hour 0 to hour 48.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from .geo import from_mercator, resample, to_mercator
from .risk import assess_levels
from .weather import Forecasts

FloatArray = npt.NDArray[np.float64]
KM_PER_MI = 1.609344
FRAMES = 49


@dataclass(frozen=True, slots=True)
class Lattice:
    west: float  # Web Mercator metres
    north: float
    cell: float
    cols: int
    rows: int
    cells: npt.NDArray[np.int64]  # row-major indices of the cells inside the corridor, row 0 at the north edge
    lat: FloatArray  # centres of those cells
    lon: FloatArray
    half_width_km: float

    def bounds(self) -> list[float]:
        """[west, south, east, north] in degrees."""
        south_lat, west_lon = from_mercator(self.west, self.north - self.rows * self.cell)
        north_lat, east_lon = from_mercator(self.west + self.cols * self.cell, self.north)
        return [float(west_lon), float(south_lat), float(east_lon), float(north_lat)]


def half_width_km(longest_mi: float) -> float:
    return min(max(0.04 * longest_mi * KM_PER_MI, 30.0), 90.0)


def build(routes: Sequence[tuple[FloatArray, FloatArray]], budget: int) -> Lattice:
    """A lattice over the corridor of `routes` (each given as polyline points and cumulative miles)."""
    longest = max(float(cum[-1]) for _, cum in routes)
    w_km = half_width_km(longest)
    step_mi = max(w_km / 3, 2.0) / KM_PER_MI
    samples = np.vstack([resample(points, cum, step_mi) for points, cum in routes])
    x, y = to_mercator(samples[:, 0], samples[:, 1])
    reach = w_km * 1000 / np.cos(np.radians(samples[:, 0]))  # W in Mercator metres at each sample
    west, east = float((x - reach).min()), float((x + reach).max())
    south, north = float((y - reach).min()), float((y + reach).max())

    total_km = sum(float(cum[-1]) for _, cum in routes) * KM_PER_MI
    scale = float(np.mean(1 / np.cos(np.radians(samples[:, 0]))))
    area = total_km * 2 * w_km * 0.75 * (1e3 * scale) ** 2
    cell = math.sqrt(area / max(budget, 1))
    mask = _mask(x, y, reach, west, north, east, south, cell)
    for _ in range(6):
        count = int(mask.sum())
        if 0.85 * budget <= count <= budget or count == 0:
            break
        cell *= math.sqrt(count / budget)
        mask = _mask(x, y, reach, west, north, east, south, cell)
    # The budget is a hard cap: every cell is a forecast location the plan pays for.
    while int(mask.sum()) > budget:
        cell *= 1.02
        mask = _mask(x, y, reach, west, north, east, south, cell)

    rows, cols = mask.shape
    inside = np.flatnonzero(mask.ravel())
    r, c = np.divmod(inside, cols)
    lat, lon = from_mercator(west + (c + 0.5) * cell, north - (r + 0.5) * cell)
    return Lattice(
        west=west, north=north, cell=cell, cols=cols, rows=rows, cells=inside, lat=lat, lon=lon, half_width_km=w_km
    )


def _mask(
    x: FloatArray, y: FloatArray, reach: FloatArray, west: float, north: float, east: float, south: float, cell: float
) -> npt.NDArray[np.bool_]:
    cols = max(math.ceil((east - west) / cell), 1)
    rows = max(math.ceil((north - south) / cell), 1)
    mask = np.zeros((rows, cols), dtype=bool)
    for px, py, pr in zip(x, y, reach, strict=True):
        c0, c1 = max(int((px - pr - west) / cell), 0), min(int((px + pr - west) / cell) + 1, cols)
        r0, r1 = max(int((north - py - pr) / cell), 0), min(int((north - py + pr) / cell) + 1, rows)
        cx = west + (np.arange(c0, c1) + 0.5) * cell
        cy = north - (np.arange(r0, r1) + 0.5) * cell
        near = (cx[None, :] - px) ** 2 + (cy[:, None] - py) ** 2 <= pr**2
        mask[r0:r1, c0:c1] |= near
    return mask


@dataclass(frozen=True, slots=True)
class Frames:
    start: float  # unix seconds of frame 0 (the departure)
    wind_mph: FloatArray  # (frames, cells)
    rain_in_hr: FloatArray
    snow_in_hr: FloatArray
    risk: npt.NDArray[np.int8]


def frames(forecasts: Forecasts, index: Sequence[int], departure_ts: float, load_lb: float) -> Frames:
    """Weather and risk at every corridor cell, every hour from departure to 48 hours later."""
    idx = np.asarray(index, dtype=np.int64)
    times = departure_ts + 3600.0 * np.arange(FRAMES)
    when = np.repeat(times, len(idx))
    where = np.tile(idx, FRAMES)
    at = forecasts.at(where, when)
    shape = (FRAMES, len(idx))
    wind = at["wind_speed_10m"].reshape(shape)
    rain = (at["rain"] + at["showers"]).reshape(shape)
    snow = at["snowfall"].reshape(shape)
    risk = assess_levels(wind, rain, snow, load_lb).reshape(shape)
    return Frames(start=departure_ts, wind_mph=wind, rain_in_hr=rain, snow_in_hr=snow, risk=risk)
