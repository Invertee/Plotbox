from __future__ import annotations

import io
import math
from pathlib import Path

import pytest
from PIL import Image, ImageDraw
from plotter_core import planning as planning_module
from plotter_core.gcode import export_gcode_bundle
from plotter_core.importers.raster_vectorize import vectorize_raster
from plotter_core.models import (
    LineCommand,
    MachineProfile,
    MoveCommand,
    PassSettings,
    ProjectRecipe,
)
from plotter_core.planning import build_plot_plan

ALGORITHMS = ("edge", "centerline", "hatch", "crosshatch", "squiggle", "tone-contour")
GOLDEN_HASHES = {
    "edge": "e81a09f600add6a659b08020c818ba1fc437fa166756353ca4ba88e42380f07d",
    "centerline": "0e29a44ba0cd37bdb6c53c77a30eec80b2015c8a75ae7d4daf5ddd3f73406554",
    "hatch": "da8ba207d6f3fa0422be2dd0cacd54a2bc1226966162dfc96368796928cb46d3",
    "crosshatch": "008a06f69ad1ece33efb5e73d88dfda867e491605f5be89b1fc72c87cdb0d943",
    "squiggle": "c3e7466d3c6e3f46efb21e438779b6fffaa7ced23b34624cf0404e8ca293b893",
    "tone-contour": "f5c6d40e23c5b4f8eb337b39c41e75a1d40ea6c012c374e72fef45fd98fd31ac",
}
COLOR_GOLDEN_HASHES = {
    "color-outline": "7c83a76f51836e9ce81756c5493bfd067a51487c174c281151ecaf4f82cefd65",
    "color-hatch": "82dab3cce114c999d9e58f8c6fdb05a27c5eda22bc072e77584cf12251679206",
}
DITHER_GOLDEN_HASHES = {
    "dots": "ad25e0d181086ea06d8d6a792830348840d3d339cbb1e86e57c2a0bebd18cbf4",
    "contrast-bands": "b1f9b2fd5485371fa330ee3b19d56b3c5408df10eee9e83b74a5704a75cb568b",
}
ROOT = Path(__file__).resolve().parents[3]


def _line_art_fixture() -> bytes:
    image = Image.new("L", (72, 54), 255)
    draw = ImageDraw.Draw(image)
    draw.rectangle((8, 7, 63, 45), outline=25, width=5)
    draw.line((8, 27, 63, 27), fill=80, width=3)
    draw.line((36, 7, 36, 18), fill=40, width=3)
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    return encoded.getvalue()


def _gradient_fixture() -> bytes:
    image = Image.new("L", (80, 48), 255)
    for y in range(image.height):
        for x in range(image.width):
            image.putpixel((x, y), round(255 * x / (image.width - 1)))
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    return encoded.getvalue()


def _recipe(algorithm: str) -> ProjectRecipe:
    recipe = ProjectRecipe(project_id=f"raster-{algorithm}", name=f"Raster {algorithm}")
    recipe.mode.mode_id = "import.raster"
    recipe.mode.quality = "draft"
    recipe.page.preset = "custom"
    recipe.page.width_mm = 90
    recipe.page.height_mm = 70
    recipe.page.margin_mm = 5
    recipe.raster_preprocess.sampling_pixels_per_pen_width = 1
    recipe.raster_vectorize.algorithm = algorithm  # type: ignore[assignment]
    recipe.geometry.simplification_tolerance_mm = 0.08
    return recipe


def _points(recipe: ProjectRecipe, algorithm: str) -> list[tuple[float, float]]:
    content = (
        _gradient_fixture()
        if algorithm in {"hatch", "crosshatch", "squiggle"}
        else _line_art_fixture()
    )
    document = vectorize_raster(
        content,
        "image/png",
        recipe,
        source_sha256="a" * 64,
    )
    return [
        (command.point.x, command.point.y)
        for path in document.layers[0].paths
        for command in path.commands
        if isinstance(command, MoveCommand | LineCommand)
    ]


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_raster_algorithms_are_deterministic_finite_and_page_space(algorithm: str) -> None:
    recipe = _recipe(algorithm)
    content = (
        _gradient_fixture()
        if algorithm in {"hatch", "crosshatch", "squiggle", "tone-contour"}
        else _line_art_fixture()
    )
    first = vectorize_raster(content, "image/png", recipe, source_sha256="a" * 64)
    second = vectorize_raster(content, "image/png", recipe, source_sha256="a" * 64)

    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    assert first.metadata.normalized_sha256 == GOLDEN_HASHES[algorithm]
    assert first.metadata.generator_id == "import.raster"
    assert first.layers[0].layer_id == f"layer-raster-{algorithm}"
    assert first.layers[0].paths
    assert first.layers[0].metadata["path_count"] == len(first.layers[0].paths)
    for x, y in _points(recipe, algorithm):
        assert math.isfinite(x) and math.isfinite(y)
        assert recipe.page.margin_mm <= x <= recipe.page.width_mm - recipe.page.margin_mm
        assert recipe.page.margin_mm <= y <= recipe.page.height_mm - recipe.page.margin_mm


def test_edge_threshold_changes_geometry_and_reports_removed_components() -> None:
    recipe = _recipe("edge")
    recipe.raster_vectorize.edge_threshold = 20
    low = vectorize_raster(
        _line_art_fixture(),
        "image/png",
        recipe,
        source_sha256="b" * 64,
    )
    recipe.raster_vectorize.edge_threshold = 180
    high = vectorize_raster(
        _line_art_fixture(),
        "image/png",
        recipe,
        source_sha256="b" * 64,
    )
    assert low.metadata.normalized_sha256 != high.metadata.normalized_sha256
    assert "removed_components" in low.layers[0].metadata


def test_centerline_skeleton_prunes_short_graph_branches() -> None:
    recipe = _recipe("centerline")
    recipe.raster_vectorize.centerline_prune_length_mm = 0
    unpruned = vectorize_raster(
        _line_art_fixture(),
        "image/png",
        recipe,
        source_sha256="c" * 64,
    )
    recipe.raster_vectorize.centerline_prune_length_mm = 12
    pruned = vectorize_raster(
        _line_art_fixture(),
        "image/png",
        recipe,
        source_sha256="c" * 64,
    )
    assert len(pruned.layers[0].paths) < len(unpruned.layers[0].paths)
    assert int(pruned.layers[0].metadata["removed_segments"]) > 0


def test_crosshatch_activates_additional_angles_for_darker_tones() -> None:
    hatch = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        _recipe("hatch"),
        source_sha256="d" * 64,
    )
    crosshatch = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        _recipe("crosshatch"),
        source_sha256="d" * 64,
    )
    assert len(crosshatch.layers[0].paths) > len(hatch.layers[0].paths)


def test_dither_dots_are_ordered_closed_marks_and_settings_change_geometry() -> None:
    recipe = _recipe("dither")
    recipe.raster_vectorize.dither_spacing_mm = 3
    recipe.raster_vectorize.dither_max_mark_size_mm = 2
    dots = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="6" * 64,
    )
    recipe.raster_vectorize.dither_contrast = 2
    higher_contrast = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="6" * 64,
    )
    assert dots.metadata.normalized_sha256 != higher_contrast.metadata.normalized_sha256
    assert dots.metadata.normalized_sha256 == DITHER_GOLDEN_HASHES["dots"]
    assert dots.layers[0].metadata["dither_mark"] == "dots"
    assert dots.layers[0].paths
    assert all(path.closed and path.commands[0].kind == "move" for path in dots.layers[0].paths)
    assert all(
        recipe.page.margin_mm <= command.point.x <= recipe.page.width_mm - recipe.page.margin_mm
        and recipe.page.margin_mm
        <= command.point.y
        <= recipe.page.height_mm - recipe.page.margin_mm
        and math.isfinite(command.point.x)
        and math.isfinite(command.point.y)
        for path in dots.layers[0].paths
        for command in path.commands
        if isinstance(command, MoveCommand | LineCommand)
    )


def test_dither_crosses_emit_two_strokes_per_ordered_mark() -> None:
    recipe = _recipe("dither")
    recipe.raster_vectorize.dither_mark = "crosses"
    recipe.raster_vectorize.dither_spacing_mm = 4
    document = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="7" * 64,
    )
    assert document.layers[0].metadata["dither_mark"] == "crosses"
    assert document.layers[0].paths
    assert all(not path.closed and len(path.commands) == 2 for path in document.layers[0].paths)


def test_dither_pen_dots_use_tip_thickness_and_round_trip_as_pen_taps() -> None:
    recipe = _recipe("dither")
    recipe.raster_vectorize.dither_mark = "pen-dots"
    recipe.raster_vectorize.dither_pen_thickness_mm = 0.7
    recipe.raster_vectorize.dither_dot_gap_mm = 0.3
    document = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="9" * 64,
    )
    plan = build_plot_plan(recipe, document)
    dots = plan.passes[0].ordered_paths
    bundle = export_gcode_bundle(recipe, plan, MachineProfile())
    source_centers = [path.commands[0].point for path in document.layers[0].paths]

    assert document.layers[0].metadata["dither_mark"] == "pen-dots"
    assert dots
    assert all(path.kind == "dot" and path.dot_diameter_mm == 0.7 for path in dots)
    assert all(len(path.points) == 1 for path in dots)
    assert [path.points[0] for path in dots] == source_centers
    assert all(program.validation.valid for program in bundle.programs)
    assert next(
        program for program in bundle.programs if program.filename == "01-black.nc"
    ).reconstructed_toolpath.draw_dots


def test_dither_contrast_bands_emit_stable_layers_for_pen_mapping() -> None:
    recipe = _recipe("dither")
    recipe.raster_vectorize.dither_pass_mode = "contrast-bands"
    recipe.raster_vectorize.dither_pass_count = 3
    first = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="8" * 64,
    )
    second = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="8" * 64,
    )
    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    assert len(first.layers) == 3
    assert [layer.semantic_role for layer in first.layers] == [
        "dither-tone-1",
        "dither-tone-2",
        "dither-tone-3",
    ]
    assert all(layer.metadata["tone_band_count"] == 3 for layer in first.layers)
    assert first.metadata.normalized_sha256 == DITHER_GOLDEN_HASHES["contrast-bands"]


@pytest.mark.parametrize("layout", ("even", "natural"))
def test_stipple_is_deterministic_and_uses_configured_pen_tip(layout: str) -> None:
    recipe = _recipe("stipple")
    recipe.raster_vectorize.stipple_layout = layout  # type: ignore[assignment]
    recipe.raster_vectorize.stipple_pen_thickness_mm = 0.7
    first = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="a" * 64,
    )
    second = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="a" * 64,
    )
    plan = build_plot_plan(recipe, first)

    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    assert first.layers[0].metadata["algorithm"] == "stipple"
    assert first.layers[0].paths
    assert all(
        path.kind == "dot" and path.dot_diameter_mm == 0.7 for path in plan.passes[0].ordered_paths
    )


def test_stipple_uses_fast_grid_path_planning(monkeypatch: pytest.MonkeyPatch) -> None:
    """Dense independent dots must not enter quadratic nearest-neighbour ordering."""

    recipe = _recipe("stipple")
    document = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="a" * 64,
    )
    original_order_paths = planning_module._order_paths
    grid_order_flags: list[bool] = []

    def record_order(
        paths: list[planning_module.PlannedPath],
        start: planning_module.Point,
        *,
        grid_order: bool = False,
    ) -> list[planning_module.PlannedPath]:
        grid_order_flags.append(grid_order)
        return original_order_paths(paths, start, grid_order=grid_order)

    monkeypatch.setattr(planning_module, "_order_paths", record_order)

    build_plot_plan(recipe, document)

    assert grid_order_flags == [True]


def test_stipple_separates_source_colours_into_pen_ready_layers() -> None:
    recipe = _recipe("stipple")
    recipe.raster_vectorize.stipple_color_mode = "separate"
    recipe.raster_vectorize.color_count = 2
    document = vectorize_raster(
        (ROOT / "fixtures" / "raster" / "two-color-poster.png").read_bytes(),
        "image/png",
        recipe,
        source_sha256="3" * 64,
    )

    assert len(document.layers) == 2
    assert all(layer.paths for layer in document.layers)
    assert all(layer.semantic_role.startswith("source-color-") for layer in document.layers)
    assert all(
        path.metadata["mark_kind"] == "pen-dot" for layer in document.layers for path in layer.paths
    )


def test_adaptive_stipple_is_separate_deterministic_and_tone_adjustable() -> None:
    recipe = _recipe("adaptive-stipple")
    recipe.raster_vectorize.adaptive_stipple_pen_thickness_mm = 0.7
    recipe.raster_vectorize.adaptive_stipple_dot_gap_mm = 0.3
    first = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="4" * 64,
    )
    second = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="4" * 64,
    )
    plan = build_plot_plan(recipe, first)

    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    assert first.metadata.generator_version == "1.0.0"
    assert first.layers[0].layer_id == "layer-raster-adaptive-stipple"
    assert first.layers[0].metadata["algorithm"] == "adaptive-stipple"
    assert first.layers[0].metadata["adaptive_stipple_local_contrast"] == 0.65
    assert first.layers[0].paths
    assert all(
        path.kind == "dot" and path.dot_diameter_mm == 0.7 for path in plan.passes[0].ordered_paths
    )

    recipe.raster_vectorize.adaptive_stipple_light_density = 2.0
    lighter_detail = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="4" * 64,
    )
    assert len(lighter_detail.layers[0].paths) > len(first.layers[0].paths)


def test_adaptive_stipple_local_contrast_changes_local_tone_geometry() -> None:
    image = Image.new("L", (80, 48), 178)
    draw = ImageDraw.Draw(image)
    draw.rectangle((28, 12, 51, 35), fill=128)
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    recipe = _recipe("adaptive-stipple")
    recipe.raster_vectorize.adaptive_stipple_local_contrast = 0
    global_only = vectorize_raster(encoded.getvalue(), "image/png", recipe, source_sha256="5" * 64)
    recipe.raster_vectorize.adaptive_stipple_local_contrast = 2
    locally_adaptive = vectorize_raster(
        encoded.getvalue(), "image/png", recipe, source_sha256="5" * 64
    )

    assert global_only.metadata.normalized_sha256 != locally_adaptive.metadata.normalized_sha256
    assert len(global_only.layers[0].paths) != len(locally_adaptive.layers[0].paths)


def test_adaptive_stipple_separates_colours_into_pen_ready_layers() -> None:
    recipe = _recipe("adaptive-stipple")
    recipe.raster_vectorize.adaptive_stipple_color_mode = "separate"
    recipe.raster_vectorize.color_count = 2
    document = vectorize_raster(
        (ROOT / "fixtures" / "raster" / "two-color-poster.png").read_bytes(),
        "image/png",
        recipe,
        source_sha256="6" * 64,
    )
    recipe.passes = [
        PassSettings(
            pass_id=f"adaptive-pass-{index}",
            name=f"Adaptive pen {index}",
            semantic_role=layer.semantic_role,
            preview_color=layer.preview_color,
            source_layer_ids=[layer.layer_id],
        )
        for index, layer in enumerate(document.layers, 1)
    ]
    plan = build_plot_plan(recipe, document)

    assert len(document.layers) == 2
    assert all(layer.paths for layer in document.layers)
    assert all(layer.metadata["algorithm"] == "adaptive-stipple" for layer in document.layers)
    assert all(layer.semantic_role.startswith("source-color-") for layer in document.layers)
    assert all(
        path.metadata["mark_kind"] == "pen-dot" for layer in document.layers for path in layer.paths
    )
    assert len(plan.passes) == 2
    assert [plot_pass.source_layer_ids for plot_pass in plan.passes] == [
        [layer.layer_id] for layer in document.layers
    ]
    bundle = export_gcode_bundle(recipe, plan, MachineProfile())
    pass_entries = [entry for entry in bundle.manifest.entries if entry.kind == "pass"]
    combined = next(program for program in bundle.programs if program.filename == "combined.nc")
    assert len(pass_entries) == 2
    assert combined.statistics.pause_count == 1
    assert all(program.validation.valid for program in bundle.programs)


def test_squiggles_are_long_continuous_scanline_paths() -> None:
    document = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        _recipe("squiggle"),
        source_sha256="e" * 64,
    )
    assert all(len(path.commands) > 10 for path in document.layers[0].paths)
    assert max(
        command.point.y
        for path in document.layers[0].paths
        for command in path.commands
        if isinstance(command, MoveCommand | LineCommand)
    ) > min(
        command.point.y
        for path in document.layers[0].paths
        for command in path.commands
        if isinstance(command, MoveCommand | LineCommand)
    )


def test_tone_contour_level_count_changes_isoline_geometry() -> None:
    recipe = _recipe("tone-contour")
    recipe.raster_vectorize.contour_levels = 3
    sparse = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="f" * 64,
    )
    recipe.raster_vectorize.contour_levels = 8
    dense = vectorize_raster(
        _gradient_fixture(),
        "image/png",
        recipe,
        source_sha256="f" * 64,
    )
    assert len(dense.layers[0].paths) > len(sparse.layers[0].paths)


def test_centerline_reaches_cooperative_cancellation_checkpoints() -> None:
    recipe = _recipe("centerline")

    def cancel(stage: str, _completed: int | None, _total: int | None) -> None:
        if stage == "skeletonize":
            raise RuntimeError("cancelled at checkpoint")

    with pytest.raises(RuntimeError, match="cancelled at checkpoint"):
        vectorize_raster(
            _line_art_fixture(),
            "image/png",
            recipe,
            source_sha256="1" * 64,
            checkpoint=cancel,
        )


@pytest.mark.parametrize("algorithm", ("color-outline", "color-hatch"))
def test_color_quantization_emits_stable_source_roles_independent_of_pens(
    algorithm: str,
) -> None:
    recipe = _recipe(algorithm)
    recipe.raster_vectorize.color_count = 2
    first = vectorize_raster(
        (ROOT / "fixtures" / "raster" / "two-color-poster.png").read_bytes(),
        "image/png",
        recipe,
        source_sha256="2" * 64,
    )
    second = vectorize_raster(
        (ROOT / "fixtures" / "raster" / "two-color-poster.png").read_bytes(),
        "image/png",
        recipe,
        source_sha256="2" * 64,
    )
    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    assert first.metadata.normalized_sha256 == COLOR_GOLDEN_HASHES[algorithm]
    assert len(first.layers) == 2
    assert all(layer.paths for layer in first.layers)
    assert all(layer.semantic_role.startswith("source-color-") for layer in first.layers)
    assert all("quantized_color" in layer.metadata for layer in first.layers)

    recipe.passes = [
        PassSettings(
            pass_id=f"pass-{index}",
            name=f"Pen {index}",
            semantic_role=layer.semantic_role,
            preview_color=("#d92f2f" if index == 1 else "#2455b5"),
            source_layer_ids=[layer.layer_id],
        )
        for index, layer in enumerate(first.layers, 1)
    ]
    plan = build_plot_plan(recipe, first)
    assert [plot_pass.source_layer_ids for plot_pass in plan.passes] == [
        [layer.layer_id] for layer in first.layers
    ]
    assert plan.source_design_sha256 == first.metadata.normalized_sha256
