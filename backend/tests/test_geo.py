import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from planner.geo import (
    cumulative_miles,
    decode_polyline,
    encode_polyline,
    from_mercator,
    haversine_mi,
    points_at,
    resample,
    to_mercator,
)


def test_decodes_googles_reference_polyline_at_precision_5():
    # The example from Google's polyline algorithm documentation.
    points = decode_polyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", precision=5)
    np.testing.assert_allclose(points, [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]])


@given(st.lists(st.tuples(st.floats(-80, 80), st.floats(-179, 179)), min_size=1, max_size=40))
def test_encode_decode_round_trip(coords):
    pts = np.round(np.array(coords), 6)
    assert decode_polyline(encode_polyline(pts)) == pytest.approx(pts, abs=1e-6)


def test_haversine_new_york_to_los_angeles():
    assert float(haversine_mi(40.7128, -74.0060, 34.0522, -118.2437)) == pytest.approx(2445.6, abs=1.0)


def test_one_degree_of_latitude_is_about_69_miles():
    assert float(haversine_mi(40, -100, 41, -100)) == pytest.approx(69.09, abs=0.05)


def test_points_along_a_line():
    pts = np.array([[0.0, 0.0], [0.0, 1.0], [1.0, 1.0]])
    cum = cumulative_miles(pts)
    assert cum[0] == 0
    assert cum[1] == pytest.approx(cum[2] - cum[1], rel=1e-3)
    mid = points_at(pts, cum, [cum[1] / 2, cum[-1], cum[-1] + 5])
    assert mid[0].tolist() == pytest.approx([0.0, 0.5])
    assert mid[1].tolist() == pytest.approx([1.0, 1.0])
    assert mid[2].tolist() == pytest.approx([1.0, 1.0])  # clamped to the end


def test_resample_keeps_both_ends():
    pts = np.array([[40.0, -100.0], [40.0, -99.0]])
    out = resample(pts, cumulative_miles(pts), 10)
    assert out[0].tolist() == [40.0, -100.0]
    assert out[-1].tolist() == pytest.approx([40.0, -99.0])
    assert len(out) == 7  # 52.9 miles in 10-mile steps


def test_mercator_round_trip():
    lat, lon = np.array([25.0, 40.0, 49.0]), np.array([-120.0, -98.0, -70.0])
    x, y = to_mercator(lat, lon)
    back_lat, back_lon = from_mercator(x, y)
    assert back_lat == pytest.approx(lat)
    assert back_lon == pytest.approx(lon)
