from __future__ import annotations

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from plotter_core.gcode import export_gcode_bundle
from plotter_core.gcode.parser import parse_gcode, reconstruct_toolpath
from plotter_core.gcode.validation import validate_program
from plotter_core.gcode.writer import FluidncZWriter, export_point
from plotter_core.generator import generate_test_design
from plotter_core.models import MachineProfile, PlannedPath, PlotPass, Point, ProjectRecipe
from plotter_core.planning import build_plot_plan

MAX_COMMENT_LINE_LENGTH = 20


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


def test_every_generated_program_lifts_pen_then_returns_to_machine_home() -> None:
    _, _, _, bundle = bundle_for()
    profile = MachineProfile()
    expected_suffix = "\n".join(
        [
            "; final pen up",
            "G1 Z5.000 F900",
            "G4 P0.080",
            "; return home",
            "G0 X0.000 Y0.000 F6000",
            "M2",
            "",
        ]
    )

    assert all(program.text.endswith(expected_suffix) for program in bundle.programs)


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


@pytest.mark.parametrize("middle", [Point(x=10, y=20), Point(x=10.0004, y=20.0004)])
def test_round_trip_accepts_adjacent_vertices_collapsed_at_export_precision(
    middle: Point,
) -> None:
    profile = MachineProfile(precision_decimals=3)
    path = PlannedPath(
        path_id="rounded-duplicate",
        source_layer_id="layer",
        points=[Point(x=10, y=20), middle, Point(x=30, y=20)],
        reversible=True,
        closed=False,
    )
    plot_pass = PlotPass(
        pass_id="pass",
        name="Black",
        semantic_role="linework",
        preview_color="#000000",
        pen_profile_id=None,
        draw_feed_mm_min=1800,
        enabled=True,
        ordered_paths=[path],
    )
    instructions = parse_gcode(FluidncZWriter(profile, "Test").pass_program(plot_pass))
    reconstructed = reconstruct_toolpath(instructions, profile)

    report = validate_program(instructions, reconstructed, profile, [path], 0.001)

    assert reconstructed.draw_paths == [
        [Point(x=10, y=20), Point(x=30, y=20)]
    ]
    assert report.valid
    assert report.issues == []


def test_export_converts_pen_dwell_milliseconds_to_fluidnc_seconds() -> None:
    program = bundle_for()[3].programs[0]

    assert "G4 P0.080" in program.text
    assert "G4 P0.120" in program.text
    assert "G4 P80" not in program.text
    assert "G4 P120" not in program.text


def test_export_limits_comment_lines_for_fluidnc() -> None:
    recipe = ProjectRecipe(
        project_id="long-comments",
        name="A project name that is deliberately much too long for FluidNC",
    )
    recipe.passes[0].name = "A pass name that is also deliberately too long"
    design = generate_test_design(recipe)
    plan = build_plot_plan(recipe, design)
    plan.passes[0].ordered_paths[0].path_id = "a-very-long-path-identifier"
    profile = MachineProfile(
        macros={
            "header": ["   ; a configurable héader comment that is too long", "G21", "G90"],
            "footer": ["; a configurable footer comment that is too long", "M2"],
        }
    )

    bundle = export_gcode_bundle(recipe, plan, profile)

    for program in bundle.programs:
        comments = [line for line in program.text.splitlines() if line.startswith(";")]
        assert comments
        assert all(len(line.encode("utf-8")) <= MAX_COMMENT_LINE_LENGTH for line in comments)


def test_per_pass_pen_down_override_round_trips_as_drawing_state() -> None:
    recipe = ProjectRecipe(project_id="override", name="Override")
    recipe.passes[0].pen_down_override = 0.25
    design = generate_test_design(recipe)
    plan = build_plot_plan(recipe, design)
    bundle = export_gcode_bundle(recipe, plan, MachineProfile())
    black = next(program for program in bundle.programs if program.filename == "01-black.nc")
    assert "G1 Z0.250 F400" in black.text
    assert black.validation.valid


def test_skew_compensation_maps_ideal_points_back_through_non_square_axes() -> None:
    profile = MachineProfile(
        skew_calibration={
            "enabled": True,
            "square_width_mm": 100,
            "square_height_mm": 100,
            "rising_diagonal_mm": 142.65,
            "falling_diagonal_mm": 140.18,
            "axis_angle_degrees": 89,
        }
    )
    ideal = Point(x=100, y=200)

    command = export_point(ideal, profile)
    angle = math.radians(profile.skew_calibration.axis_angle_degrees)
    physical_x = command.x + command.y * math.cos(angle)
    physical_y = command.y * math.sin(angle)
    translation = profile.work_height_mm * math.cos(angle) / math.sin(angle)

    assert physical_x == pytest.approx(ideal.x + translation)
    assert physical_y == pytest.approx(ideal.y)

    recipe, _, plan, _ = bundle_for()
    compensated = export_gcode_bundle(recipe, plan, profile)
    assert compensated.manifest.valid
    assert all(program.validation.valid for program in compensated.programs)


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
