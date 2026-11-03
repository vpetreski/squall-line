"""Geometry on the route: polylines, distances along them and Web Mercator.

Distances use the haversine formula on a sphere with the mean Earth radius. Over a road polyline with points
every few hundred metres that is within a fraction of a percent of the ellipsoidal length, and route lengths
are rescaled to the routing engine's own total anyway.
"""

from __future__ import annotations

import math

import numpy as np
import numpy.typing as npt

EARTH_RADIUS_MI = 3958.7613
EARTH_RADIUS_M = 6_371_008.8
METERS_PER_MILE = 1609.344
MERCATOR_MAX_LAT = 85.05112878

FloatArray = npt.NDArray[np.float64]


def decode_polyline(encoded: str, precision: int = 6) -> FloatArray:
    """Decode a Google-style encoded polyline into an (n, 2) array of [lat, lon]."""
    factor = 10.0**precision
    coords: list[tuple[float, float]] = []
    index = lat = lon = 0
    length = len(encoded)
    while index < length:
        deltas = []
        for _ in range(2):
            shift = result = 0
            while True:
                byte = ord(encoded[index]) - 63
                index += 1
                result |= (byte & 0x1F) << shift
                shift += 5
                if byte < 0x20:
                    break
            deltas.append(~(result >> 1) if result & 1 else result >> 1)
        lat += deltas[0]
        lon += deltas[1]
        coords.append((lat / factor, lon / factor))
    return np.array(coords, dtype=float).reshape(-1, 2)


def encode_polyline(points: npt.ArrayLike, precision: int = 6) -> str:
    """Encode [lat, lon] points; the inverse of `decode_polyline`."""
    factor = 10**precision
    out: list[str] = []
    prev_lat = prev_lon = 0
    for lat, lon in np.asarray(points, dtype=float):
        ilat, ilon = round(lat * factor), round(lon * factor)
        for delta in (ilat - prev_lat, ilon - prev_lon):
            value = ~(delta << 1) if delta < 0 else delta << 1
            while value >= 0x20:
                out.append(chr((0x20 | (value & 0x1F)) + 63))
                value >>= 5
            out.append(chr(value + 63))
        prev_lat, prev_lon = ilat, ilon
    return "".join(out)


def haversine_mi(lat1: npt.ArrayLike, lon1: npt.ArrayLike, lat2: npt.ArrayLike, lon2: npt.ArrayLike) -> FloatArray:
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return np.asarray(2 * EARTH_RADIUS_MI * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0))), dtype=float)


def cumulative_miles(points: FloatArray) -> FloatArray:
    """Distance from the first point to every point of the polyline."""
    if len(points) == 0:
        return np.zeros(0)
    steps = haversine_mi(points[:-1, 0], points[:-1, 1], points[1:, 0], points[1:, 1])
    return np.concatenate([[0.0], np.cumsum(steps)])


def points_at(points: FloatArray, cum_mi: FloatArray, miles: npt.ArrayLike) -> FloatArray:
    """[lat, lon] at each given distance along the polyline (linear between vertices)."""
    m = np.clip(np.asarray(miles, dtype=float), 0.0, cum_mi[-1])
    lat = np.interp(m, cum_mi, points[:, 0])
    lon = np.interp(m, cum_mi, points[:, 1])
    return np.column_stack([lat, lon])


def resample(points: FloatArray, cum_mi: FloatArray, step_mi: float) -> FloatArray:
    """Points every `step_mi` along the line, the last point included."""
    total = float(cum_mi[-1])
    count = max(math.ceil(total / step_mi), 1)
    return points_at(points, cum_mi, np.linspace(0.0, total, count + 1))


def simplify(points: FloatArray, tolerance_m: float = 15.0) -> FloatArray:
    """Douglas-Peucker on a local equirectangular projection; keeps both ends."""
    n = len(points)
    if n < 3:
        return points
    lat0 = np.radians(points[:, 0].mean())
    xy = np.column_stack([np.radians(points[:, 1]) * np.cos(lat0), np.radians(points[:, 0])]) * EARTH_RADIUS_M
    keep = np.zeros(n, dtype=bool)
    keep[[0, -1]] = True
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        seg = xy[b] - xy[a]
        rel = xy[a + 1 : b] - xy[a]
        length = math.hypot(seg[0], seg[1])
        if length == 0:
            dist = np.hypot(rel[:, 0], rel[:, 1])
        else:
            dist = np.abs(rel[:, 0] * seg[1] - rel[:, 1] * seg[0]) / length
        i = int(dist.argmax())
        if dist[i] > tolerance_m:
            mid = a + 1 + i
            keep[mid] = True
            stack += [(a, mid), (mid, b)]
    return points[keep]


def to_mercator(lat: npt.ArrayLike, lon: npt.ArrayLike) -> tuple[FloatArray, FloatArray]:
    """Spherical Web Mercator (EPSG:3857) metres."""
    la = np.clip(np.asarray(lat, dtype=float), -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT)
    x = EARTH_RADIUS_M * np.radians(np.asarray(lon, dtype=float))
    y = EARTH_RADIUS_M * np.log(np.tan(np.pi / 4 + np.radians(la) / 2))
    return x, y


def from_mercator(x: npt.ArrayLike, y: npt.ArrayLike) -> tuple[FloatArray, FloatArray]:
    lon = np.degrees(np.asarray(x, dtype=float) / EARTH_RADIUS_M)
    lat = np.degrees(2 * np.arctan(np.exp(np.asarray(y, dtype=float) / EARTH_RADIUS_M)) - np.pi / 2)
    return lat, lon
