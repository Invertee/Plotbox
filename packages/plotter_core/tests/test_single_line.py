from __future__ import annotations

import io
import math
from itertools import pairwise

import pytest
from PIL import Image, ImageDraw
from plotter_core.gcode import export_gcode_bundle
from plotter_core.importers import single_line
from plotter_core.importers.raster_vectorize import vectorize_raster
from plotter_core.models import MachineProfile, ProjectRecipe, RasterPlacement
from plotter_core.planning import build_plot_plan

ALGORITHMS = ("spiral-wave", "arc-scribble", "travelling-salesman")


def recipe(algorithm: str) -> ProjectRecipe:
    result = ProjectRecipe(project_id="single-line-test", name="Continuous line")
    result.mode.mode_id = "import.raster"
    result.mode.quality = "draft"
    result.page.width_mm = 90
    result.page.height_mm = 90
    result.page.margin_mm = 5
    result.raster_vectorize.algorithm = algorithm  # type: ignore[assignment]
    result.raster_vectorize.single_line_point_count = 200
    result.raster_vectorize.tsp_smoothing = 0.8
    return result


def content() -> bytes:
    image = Image.new("L", (64, 64), 245)
    draw = ImageDraw.Draw(image)
    draw.ellipse((8, 4, 56, 60), fill=90)
    draw.ellipse((16, 18, 26, 28), fill=240)
    draw.ellipse((38, 18, 48, 28), fill=240)
    draw.arc((20, 30, 44, 50), 0, 180, fill=15, width=4)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_continuous_deterministic_bounded_and_round_trip_exportable(algorithm: str) -> None:
    settings = recipe(algorithm)
    first = vectorize_raster(content(), "image/png", settings, source_sha256="a" * 64)
    second = vectorize_raster(content(), "image/png", settings, source_sha256="a" * 64)
    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    paths = [path for layer in first.layers for path in layer.paths]
    assert len(paths) == 1
    assert sum(command.kind == "move" for command in paths[0].commands) == 1
    for command in paths[0].commands:
        point = command.point  # type: ignore[union-attr]
        assert math.isfinite(point.x) and math.isfinite(point.y)
        assert 5 <= point.x <= 85 and 5 <= point.y <= 85
    plan = build_plot_plan(settings, first)
    assert sum(len(plot_pass.ordered_paths) for plot_pass in plan.passes) == 1
    bundle = export_gcode_bundle(settings, plan, MachineProfile())
    assert all(program.validation.valid for program in bundle.programs)


def _proper_crossing(a, b, c, d) -> bool:
    # Independent brute-force geometry assertion, including rounded export coordinates.
    def side(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    return side(a, b, c) * side(a, b, d) < 0 and side(c, d, a) * side(c, d, b) < 0


@pytest.mark.parametrize("smoothing", [0, 0.5, 1])
def test_tsp_has_no_crossings_after_corner_rounding(smoothing: float) -> None:
    settings = recipe("travelling-salesman")
    settings.raster_vectorize.tsp_smoothing = smoothing
    image = Image.open(io.BytesIO(content()))
    placement = RasterPlacement(x_mm=5, y_mm=5, width_mm=80, height_mm=80)
    points = single_line.single_line_paths(image, settings, placement)[0]
    assert points[0] == points[-1]
    assert len(points) > 200 if smoothing else len(points) == 201
    rounded = [(round(x, 3), round(y, 3)) for x, y in points]
    segments = list(pairwise(rounded))
    for i, (a, b) in enumerate(segments):
        for c, d in segments[i + 2 :]:
            assert not _proper_crossing(a, b, c, d)


def test_spiral_modulates_frequency_with_darkness() -> None:
    settings = recipe("spiral-wave")
    placement = RasterPlacement(x_mm=5, y_mm=5, width_mm=80, height_mm=80)
    light = single_line.spiral_wave(Image.new("L", (40, 40), 255), settings, placement, None)
    dark = single_line.spiral_wave(Image.new("L", (40, 40), 0), settings, placement, None)
    assert dark[0] == light[0] == (45, 45)
    assert len(dark) > len(light) * 2
    assert sum(math.dist(a, b) for a, b in pairwise(dark)) > (
        sum(math.dist(a, b) for a, b in pairwise(light)) * 1.5
    )


def test_route_points_concentrate_in_dark_areas_and_seed_changes_route() -> None:
    settings = recipe("travelling-salesman")
    image = Image.new("L", (60, 60), 210)
    ImageDraw.Draw(image).rectangle((0, 0, 29, 59), fill=20)
    placement = RasterPlacement(x_mm=0, y_mm=0, width_mm=60, height_mm=60)
    tone = single_line.Tone(image, placement, 1)
    points = single_line._sites(tone, settings, 0.02, None)
    assert sum(x < 30 for x, _ in points) > len(points) * 0.7
    settings.mode.seed = "different"
    assert points != single_line._sites(tone, settings, 0.02, None)


def test_arcs_use_smaller_tighter_loops_in_dark_regions() -> None:
    settings = recipe("arc-scribble")
    placement = RasterPlacement(x_mm=0, y_mm=0, width_mm=60, height_mm=60)
    route = [(10.0, 30.0), (50.0, 30.0)]
    light = single_line._arc_scribble(
        route, single_line.Tone(Image.new("L", (60, 60), 255), placement, 1), settings, None
    )
    dark = single_line._arc_scribble(
        route, single_line.Tone(Image.new("L", (60, 60), 0), placement, 1), settings, None
    )
    assert len(dark) > len(light) * 5
    assert max(abs(y - 30) for _, y in dark) < max(abs(y - 30) for _, y in light) / 2


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_single_line_work_is_cooperatively_cancellable(algorithm: str) -> None:
    settings = recipe(algorithm)

    def stop(stage: str, _done: int | None, _total: int | None) -> None:
        if stage in {"spiral-waves", "building-travelling-salesman-route"}:
            raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        single_line.single_line_paths(
            Image.new("L", (40, 40), 80),
            settings,
            RasterPlacement(x_mm=5, y_mm=5, width_mm=80, height_mm=80),
            stop,
        )


def test_detail_budget_rejects_instead_of_truncating(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(single_line, "MAX_VERTICES", 100)
    with pytest.raises(ValueError, match="detail exceeds"):
        single_line.single_line_paths(
            Image.new("L", (40, 40), 0),
            recipe("spiral-wave"),
            RasterPlacement(x_mm=5, y_mm=5, width_mm=80, height_mm=80),
        )


@pytest.mark.parametrize("algorithm", ["arc-scribble", "travelling-salesman"])
def test_blank_source_has_no_artificial_tour(algorithm: str) -> None:
    assert (
        single_line.single_line_paths(
            Image.new("L", (40, 40), 255),
            recipe(algorithm),
            RasterPlacement(x_mm=5, y_mm=5, width_mm=80, height_mm=80),
        )
        == []
    )


def test_invalid_arc_radii_are_rejected() -> None:
    with pytest.raises(ValueError, match="dark radius"):
        ProjectRecipe.model_validate(
            {
                "project_id": "bad",
                "name": "Bad",
                "raster_vectorize": {"arc_min_radius_mm": 4, "arc_max_radius_mm": 2},
            }
        )
