import numpy as np
import pytest
from hypothesis import given
from hypothesis import strategies as st

from planner.checkpoints import checkpoint_miles, place, represented_miles
from planner.geo import cumulative_miles


@pytest.mark.parametrize(
    ("length", "interval", "marks"),
    [
        (100, 25, [0, 25, 50, 75, 100]),
        (110, 25, [0, 25, 50, 75, 100, 110]),
        (101, 25, [0, 25, 50, 75, 101]),  # 100 is within a tenth of the interval of the end
        (10, 25, [0, 10]),
        (1, 50, [0, 1]),
        (0, 10, [0]),
    ],
)
def test_checkpoint_miles(length, interval, marks):
    assert checkpoint_miles(length, interval).tolist() == pytest.approx(marks)


def test_represented_miles_split_the_route():
    marks = np.array([0.0, 25, 50, 75, 101])
    assert represented_miles(marks).tolist() == pytest.approx([12.5, 25, 25, 25.5, 13])


@given(st.floats(0.5, 3000), st.sampled_from([10, 25, 50]))
def test_represented_miles_add_up_to_the_length(length, interval):
    marks = checkpoint_miles(length, interval)
    assert represented_miles(marks).sum() == pytest.approx(length)
    assert np.all(np.diff(marks) > 0)
    assert marks[0] == 0
    assert marks[-1] == pytest.approx(length)


def test_place_interpolates_position_and_time():
    points = np.array([[40.0, -100.0], [40.0, -99.0], [40.0, -98.0]])
    cum = cumulative_miles(points)
    drive = cum / cum[-1] * 7200  # two hours at constant speed
    cps = place(points, cum, drive, 25, None)
    assert cps[0].mile == 0
    assert cps[-1].mile == pytest.approx(cum[-1])
    assert cps[1].mile == 25
    assert cps[1].lon == pytest.approx(-100 + 25 / cum[1], rel=1e-3)
    assert cps[1].drive_s == pytest.approx(7200 * 25 / cum[-1])
    assert sum(c.represents_mi for c in cps) == pytest.approx(cum[-1])
