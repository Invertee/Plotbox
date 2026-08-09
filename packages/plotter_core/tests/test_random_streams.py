from __future__ import annotations

import json
import subprocess
import sys

import pytest
from plotter_core.models import ModeSettings
from plotter_core.modes import NamedRandomStreams, normalize_seed
from plotter_core.modes.registry import get_mode_registry


def test_seed_normalization_uses_canonical_unicode_without_discarding_content() -> None:
    assert normalize_seed("Cafe\u0301") == "Caf\u00e9"
    assert normalize_seed("  meaningful spacing  ") == "  meaningful spacing  "
    with pytest.raises(ValueError, match="must not be empty"):
        normalize_seed(" \t ")
    with pytest.raises(ValueError, match="valid Unicode"):
        normalize_seed("\ud800")


def test_prepared_mode_settings_persist_the_canonical_seed() -> None:
    prepared = (
        get_mode_registry()
        .get("builtin.test-pattern")
        .prepare_settings(ModeSettings(seed="Cafe\u0301"))
    )
    assert prepared.seed == "Caf\u00e9"


def test_named_streams_are_independent_and_mode_scoped() -> None:
    streams = NamedRandomStreams("shared-seed", "builtin.mode-a")
    layout = [streams.scalar("layout").random() for _ in range(2)]
    assert layout[0] == layout[1]
    assert streams.digest("layout") != streams.digest("detail")
    assert streams.digest("layout") != NamedRandomStreams("shared-seed", "builtin.mode-b").digest(
        "layout"
    )
    assert streams.digest("layout") != NamedRandomStreams(
        "different-seed", "builtin.mode-a"
    ).digest("layout")


def test_scalar_and_numpy_entropy_are_stable_across_processes() -> None:
    streams = NamedRandomStreams("cross-process-\u03c0", "builtin.fixture")
    expected = {
        "scalar": [streams.scalar("layout").random(), streams.scalar("detail").random()],
        "numpy": streams.numpy_seed_sequence("layout"),
    }
    script = """
import json
from plotter_core.modes import NamedRandomStreams
streams = NamedRandomStreams("cross-process-\u03c0", "builtin.fixture")
print(json.dumps({
    "scalar": [streams.scalar("layout").random(), streams.scalar("detail").random()],
    "numpy": streams.numpy_seed_sequence("layout"),
}))
"""
    completed = subprocess.run(
        [sys.executable, "-c", script],
        check=True,
        capture_output=True,
        text=True,
    )
    assert json.loads(completed.stdout) == {
        "scalar": expected["scalar"],
        "numpy": list(expected["numpy"]),
    }
