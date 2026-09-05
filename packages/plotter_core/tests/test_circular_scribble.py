from __future__ import annotations

import io
import math

from PIL import Image
from plotter_core.importers.raster_vectorize import vectorize_raster
from plotter_core.models import DesignDocument, LineCommand, MoveCommand, ProjectRecipe
from plotter_core.planning import build_plot_plan


def _gradient_fixture() -> bytes:
    image = Image.new("L", (96, 64), 255)
    for y in range(image.height):
        for x in range(image.width):
            image.putpixel((x, y), round(255 * x / (image.width - 1)))
    encoded = io.BytesIO()
    image.save(encoded, format="PNG")
    return encoded.getvalue()


def _recipe() -> ProjectRecipe:
    recipe = ProjectRecipe(project_id="raster-circular-scribble", name="Circular scribble")
    recipe.mode.mode_id = "import.raster"
    recipe.mode.quality = "draft"
    recipe.page.preset = "custom"
    recipe.page.width_mm = 90
    recipe.page.height_mm = 70
    recipe.page.margin_mm = 5
    recipe.raster_preprocess.sampling_pixels_per_pen_width = 1
    recipe.raster_vectorize.algorithm = "circular-scribble"
    recipe.raster_vectorize.squiggle_spacing_mm = 4
    recipe.raster_vectorize.squiggle_amplitude_mm = 1.4
    recipe.raster_vectorize.squiggle_wavelength_mm = 6
    recipe.raster_vectorize.squiggle_modulation = "both"
    return recipe


def _points(document: DesignDocument) -> list[tuple[float, float]]:
    return [
        (command.point.x, command.point.y)
        for path in document.layers[0].paths
        for command in path.commands
        if isinstance(command, MoveCommand | LineCommand)
    ]


def test_circular_scribble_is_deterministic_single_path_and_tone_aware() -> None:
    recipe = _recipe()
    content = _gradient_fixture()
    first = vectorize_raster(content, "image/png", recipe, source_sha256="9" * 64)
    second = vectorize_raster(content, "image/png", recipe, source_sha256="9" * 64)

    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    assert first.layers[0].layer_id == "layer-raster-circular-scribble"
    assert first.layers[0].metadata["path_count"] == 1
    assert len(first.layers[0].paths) == 1
    path = first.layers[0].paths[0]
    assert not path.closed
    assert isinstance(path.commands[0], MoveCommand)
    assert all(isinstance(command, LineCommand) for command in path.commands[1:])
    assert len(path.commands) > 500

    points = _points(first)
    assert all(
        math.isfinite(x)
        and math.isfinite(y)
        and recipe.page.margin_mm <= x <= recipe.page.width_mm - recipe.page.margin_mm
        and recipe.page.margin_mm <= y <= recipe.page.height_mm - recipe.page.margin_mm
        for x, y in points
    )
    midpoint = recipe.page.width_mm / 2
    dark_vertices = sum(x < midpoint for x, _ in points)
    light_vertices = sum(x >= midpoint for x, _ in points)
    assert dark_vertices > light_vertices * 1.25
    assert build_plot_plan(recipe, first).statistics.path_count == 1


def test_circular_scribble_tone_modulation_changes_geometry() -> None:
    recipe = _recipe()
    content = _gradient_fixture()
    adaptive = vectorize_raster(content, "image/png", recipe, source_sha256="a" * 64)
    recipe.raster_vectorize.squiggle_modulation = "amplitude"
    fixed_pitch = vectorize_raster(content, "image/png", recipe, source_sha256="a" * 64)

    assert adaptive.metadata.normalized_sha256 != fixed_pitch.metadata.normalized_sha256
    assert len(adaptive.layers[0].paths[0].commands) > len(fixed_pitch.layers[0].paths[0].commands)
