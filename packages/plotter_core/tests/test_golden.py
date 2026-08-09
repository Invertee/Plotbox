from __future__ import annotations

import json
from pathlib import Path

from plotter_core.gcode import export_gcode_bundle
from plotter_core.generator import generate_test_design
from plotter_core.models import MachineProfile, ProjectRecipe
from plotter_core.planning import build_plot_plan

ROOT = Path(__file__).resolve().parents[3]


def test_vertical_slice_golden_hashes_are_intentional() -> None:
    expected = json.loads((ROOT / "fixtures" / "golden-hashes.json").read_text(encoding="utf-8"))
    recipe = ProjectRecipe.model_validate_json(
        (ROOT / "fixtures" / "projects" / "vertical-slice-a3.json").read_text(encoding="utf-8")
    )
    design = generate_test_design(recipe)
    plan = build_plot_plan(recipe, design)
    bundle = export_gcode_bundle(recipe, plan, MachineProfile())
    actual = {
        "design_sha256": design.metadata.normalized_sha256,
        "plot_plan_sha256": plan.normalized_sha256,
        "manifest_sha256": bundle.manifest.manifest_sha256,
        "program_sha256": {program.filename: program.sha256 for program in bundle.programs},
    }
    assert actual == expected
    for program in bundle.programs:
        fixture = (ROOT / "fixtures" / "gcode" / "vertical-slice-a3" / program.filename).read_text(
            encoding="utf-8"
        )
        assert fixture == program.text
