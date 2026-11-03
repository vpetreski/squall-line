"""The frontend's test fixtures are real plans: the replayed pipeline's output, as the API sends it.

Regenerate them with `UPDATE_FIXTURES=1 pytest tests/test_frontend_fixtures.py` after a change to the plan.
"""

from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path

import pytest

from planner import risk, service
from planner.schemas import PlanIn, PlanOut

from .replay import load

FRONTEND = Path(__file__).resolve().parents[2] / "frontend" / "src" / "fixtures"
CASES = ["sacramento-reno", "chicago-atlanta"]


@pytest.mark.skipif(not FRONTEND.parent.is_dir(), reason="no frontend next to this backend")
@pytest.mark.parametrize("name", CASES)
def test_frontend_fixture_is_the_pipeline_output(name, replay):
    case = load(name)
    replay(case["exchanges"])
    out = service.plan(PlanIn(**case["payload"]), now=datetime.fromisoformat(case["now"]))
    sent = PlanOut.model_validate(out).model_dump(mode="json")
    sent["meta"]["timings_ms"] = {}  # the only part that changes from run to run
    target = FRONTEND / f"{name}.json"
    if os.environ.get("UPDATE_FIXTURES"):
        target.write_text(json.dumps(sent, separators=(",", ":")) + "\n")
    assert json.loads(target.read_text()) == sent


@pytest.mark.skipif(not FRONTEND.parent.is_dir(), reason="no frontend next to this backend")
def test_frontend_rules_fixture_is_the_published_table():
    sent = json.loads(json.dumps(risk.rules_table()))
    target = FRONTEND / "rules.json"
    if os.environ.get("UPDATE_FIXTURES"):
        target.write_text(json.dumps(sent, indent=2) + "\n")
    assert json.loads(target.read_text()) == sent
