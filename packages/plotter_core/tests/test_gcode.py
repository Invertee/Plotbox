from __future__ import annotations

from hypothesis import given, settings
from hypothesis import strategies as st
from plotter_core.gcode import export_gcode_bundle
from plotter_core.gcode.parser import parse_gcode, reconstruct_toolpath
from plotter_core.generator import generate_test_design
from plotter_core.models import MachineProfile, Point, ProjectRecipe
from plotter_core.planning import build_plot_plan


def bundle_for(seed: str = "codex-vertical-slice-1"):
    recipe = ProjectRecipe(
        project_id="gcode-golden",
        name="G-code golden",
        mode={"seed": seed, "quality": "export"},
    )
    design = generate_test_design(recipe)
    plan = build_plot_plan(recipe, design)
    return recipe, design, plan, export_gcode_bundle(recipe, plan, MachineProfile())


def test_bundle_has_required_files_and_valid_round_trip() -> None:
    _, _, plan, bundle = bundle_for()
    names = [program.filename for program in bundle.programs]
    assert names == [
        "01-black.nc",
        "02-cyan.nc",
        "combined.nc",
        "dry-run.nc",
        "page-boundary.nc",
    ]
    assert bundle.manifest.valid
    assert all(program.validation.valid for program in bundle.programs)
    assert (
        next(
            program for program in bundle.programs if program.filename == "combined.nc"
        ).statistics.pause_count
        == 1
    )
    assert all(
        program.statistics.pause_count == 0
        for program in bundle.programs
        if program.filename != "combined.nc"
    )
    assert all(
        not segment.pen_down
        for program in bundle.programs
        if program.filename in {"dry-run.nc", "page-boundary.nc"}
        for segment in program.reconstructed_toolpath.segments
    )
    assert bundle.manifest.plot_plan_sha256 == plan.normalized_sha256


def test_export_is_byte_for_byte_deterministic() -> None:
    first = bundle_for()[3]
    second = bundle_for()[3]
    assert first.manifest == second.manifest
    assert first.archive_base64 == second.archive_base64
    assert [program.sha256 for program in first.programs] == [
        program.sha256 for program in second.programs
    ]


def test_parser_reconstructs_hand_authored_modal_program() -> None:
    profile = MachineProfile()
    instructions = parse_gcode(
        "\n".join(
            [
                "G21",
                "G90",
                "G17",
                "G94",
                "G1 Z5 F900",
                "G0 X10 Y20",
                "G1 Z0 F400",
                "G1 X30 Y20 F1800",
                "G1 Z5 F900",
                "M2",
            ]
        )
    )
    reconstructed = reconstruct_toolpath(instructions, profile)
    assert reconstructed.draw_paths == [[Point(x=10.0, y=20.0), Point(x=30.0, y=20.0)]]
    assert reconstructed.final_z_mm == 5


def test_export_converts_pen_dwell_milliseconds_to_fluidnc_seconds() -> None:
    program = bundle_for()[3].programs[0]

    assert "G4 P0.080" in program.text
    assert "G4 P0.120" in program.text
    assert "G4 P80" not in program.text
    assert "G4 P120" not in program.text


def test_per_pass_pen_down_override_round_trips_as_drawing_state() -> None:
    recipe = ProjectRecipe(project_id="override", name="Override")
    recipe.passes[0].pen_down_override = 0.25
    design = generate_test_design(recipe)
    plan = build_plot_plan(recipe, design)
    bundle = export_gcode_bundle(recipe, plan, MachineProfile())
    black = next(program for program in bundle.programs if program.filename == "01-black.nc")
    assert "G1 Z0.250 F400" in black.text
    assert black.validation.valid


@given(
    seed=st.text(
        alphabet=st.characters(min_codepoint=33, max_codepoint=126), min_size=1, max_size=24
    )
)
@settings(max_examples=15, deadline=None)
def test_generated_programs_round_trip_for_arbitrary_seed(seed: str) -> None:
    _, _, _, bundle = bundle_for(seed)
    assert all(program.validation.valid for program in bundle.programs)
    combined = next(program for program in bundle.programs if program.filename == "combined.nc")
    assert combined.statistics.pause_count == 1
