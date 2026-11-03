from __future__ import annotations

import os

import pytest

from config.settings import load_dotenv


def test_a_local_env_file_fills_in_only_what_is_not_set(tmp_path, monkeypatch: pytest.MonkeyPatch):
    for name in ("SQL_TEST_A", "SQL_TEST_B", "SQL_TEST_C", "SQL_TEST_D"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SQL_TEST_D", "from the environment")
    env = tmp_path / ".env"
    env.write_text(
        "# a comment\n"
        "SQL_TEST_A=plain\n"
        "export SQL_TEST_B = 'quoted value'\n"
        'SQL_TEST_C="a=b"\n'
        "SQL_TEST_D=from the file\n"
        "not a setting\n"
    )
    load_dotenv(env)
    assert os.environ["SQL_TEST_A"] == "plain"
    assert os.environ["SQL_TEST_B"] == "quoted value"
    assert os.environ["SQL_TEST_C"] == "a=b"
    assert os.environ["SQL_TEST_D"] == "from the environment"


def test_no_env_file_is_fine(tmp_path):
    load_dotenv(tmp_path / "missing.env")
