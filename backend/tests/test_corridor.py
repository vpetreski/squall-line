from __future__ import annotations

import numpy as np
import pytest

from planner import corridor
from planner.geo import cumulative_miles, haversine_mi, resample
from planner.risk import assess_levels
from planner.weather import HOURLY, Forecasts


def straight(lat: float, lon0: float, lon1: float, n: int = 300) -> tuple[np.ndarray, np.ndarray]:
    pts = np.column_stack([np.full(n, lat), np.linspace(lon0, lon1, n)])
    return pts, cumulative_miles(pts)


@pytest.mark.parametrize(("miles", "km"), [(100, 30.0), (1000, 64.37), (3000, 90.0)])
def test_corridor_half_width(miles, km):
    assert corridor.half_width_km(miles) == pytest.approx(km, abs=0.01)


@pytest.mark.parametrize("budget", [120, 200, 260])
def test_the_lattice_hits_its_budget_and_stays_in_the_corridor(budget):
    route = straight(40.0, -105.0, -95.0)
    lattice = corridor.build([route], budget)
    assert 0.85 * budget <= len(lattice.cells) <= budget
    samples = resample(route[0], route[1], 1.0)
    cell_km = lattice.cell / 1000 * np.cos(np.radians(40.0))
    for lat, lon in zip(lattice.lat, lattice.lon, strict=True):
        nearest_km = float(haversine_mi(lat, lon, samples[:, 0], samples[:, 1]).min()) * 1.609344
        assert nearest_km <= lattice.half_width_km + cell_km
    west, south, east, north = lattice.bounds()
    assert west < -105.0 < -95.0 < east
    assert south < 40.0 < north
    assert len(np.unique(lattice.cells)) == len(lattice.cells)


@pytest.mark.parametrize("budget", [120, 150, 200])
@pytest.mark.parametrize(
    "ends",
    [((40.7, -74.0), (34.05, -118.24)), ((47.6, -122.3), (25.8, -80.2)), ((41.9, -87.6), (42.3, -83.0))],
)
def test_the_budget_is_never_exceeded(budget, ends):
    (lat0, lon0), (lat1, lon1) = ends
    pts = np.column_stack([np.linspace(lat0, lat1, 400), np.linspace(lon0, lon1, 400)])
    bent = pts + np.column_stack([np.sin(np.linspace(0, 3 * np.pi, 400)) * 1.5, np.zeros(400)])
    routes = [(p, cumulative_miles(p)) for p in (pts, bent)]
    assert len(corridor.build(routes, budget).cells) <= budget


def test_frames_are_hourly_from_departure_with_the_same_rules_as_checkpoints():
    hours = 60
    t0 = 1_793_725_200
    n = 4
    fields = {name: np.zeros((n, hours)) for name in HOURLY}
    fields["wind_speed_10m"] = np.tile(np.linspace(20, 60, hours), (n, 1))
    fields["rain"] = np.full((n, hours), 0.2)
    fields["snowfall"] = np.full((n, hours), 0.6)
    forecasts = Forecasts(times=(t0 + 3600 * np.arange(hours)).astype(np.int64), fields=fields)
    frames = corridor.frames(forecasts, [0, 2], t0 + 1800, load_lb=35_000)
    assert frames.wind_mph.shape == (corridor.FRAMES, 2)
    assert frames.start == t0 + 1800
    at = forecasts.at([0] * corridor.FRAMES, t0 + 1800 + 3600 * np.arange(corridor.FRAMES))
    np.testing.assert_allclose(frames.wind_mph[:, 0], at["wind_speed_10m"])
    expected = assess_levels(at["wind_speed_10m"], at["rain"] + at["showers"], at["snowfall"], 35_000)
    assert frames.risk[:, 0].tolist() == expected.tolist()
