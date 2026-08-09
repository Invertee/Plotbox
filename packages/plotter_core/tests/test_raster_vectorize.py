from __future__ import annotations

import io
import math
from pathlib import Path

import pytest
from PIL import Image, ImageDraw
from plotter_core.importers.raster_vectorize import vectorize_raster
from plotter_core.models import LineCommand, MoveCommand, PassSettings, ProjectRecipe
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
