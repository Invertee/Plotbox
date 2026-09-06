from __future__ import annotations

import io
import math
from itertools import pairwise

import pytest
from PIL import Image, ImageDraw, ImageStat
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
    for pen in settings.pen_palette:
        pen.tip_width_mm = 1
    image = Image.open(io.BytesIO(content()))
    placement = RasterPlacement(x_mm=5, y_mm=5, width_mm=16, height_mm=16)
    points = single_line.single_line_paths(image, settings, placement)[0]
    assert points[0] != points[-1]
    assert len(points) > 20
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


def render_path(
    points: list[tuple[float, float]], placement: RasterPlacement, pen_width: float = 0.5
) -> Image.Image:
    scale = 12
    output = Image.new(
        "L", (round(placement.width_mm * scale), round(placement.height_mm * scale)), 255
    )
    ImageDraw.Draw(output).line(
        [
            ((x - placement.x_mm) * scale, (placement.y_mm + placement.height_mm - y) * scale)
            for x, y in points
        ],
        fill=0,
        width=round(pen_width * scale),
    )
    return output


def ink_coverage(image: Image.Image) -> float:
    return 1 - ImageStat.Stat(image).mean[0] / 255


@pytest.mark.parametrize("algorithm", ["arc-scribble", "travelling-salesman"])
def test_rendered_tones_match_absolute_source_darkness(algorithm: str) -> None:
    settings = recipe(algorithm)
    settings.mode.quality = "standard"
    settings.raster_vectorize.tsp_smoothing = 0
    source = Image.new("L", (240, 120))
    for i, tone in enumerate([0, 51, 102, 153, 204, 255]):
        ImageDraw.Draw(source).rectangle((i * 40, 0, (i + 1) * 40 - 1, 119), fill=tone)
    placement = RasterPlacement(x_mm=13, y_mm=21, width_mm=120, height_mm=60)
    path = single_line.single_line_paths(source, settings, placement)[0]
    rendered = render_path(path, placement)
    # Measure actual coverage, not the number of vertices on a sparse carrier line.
    measured = [
        ink_coverage(rendered.crop((i * 240 + 24, 24, (i + 1) * 240 - 24, 696))) for i in range(6)
    ]
    for actual, expected in zip(measured, [1, 0.8, 0.6, 0.4, 0.2, 0], strict=True):
        assert abs(actual - expected) < 0.13, measured
    assert measured[0] > 0.86
    assert measured[-1] < 0.08
    assert all(a > b for a, b in pairwise(measured))


@pytest.mark.parametrize("algorithm", ["arc-scribble", "travelling-salesman"])
def test_gamma_changes_rendered_uniform_midtones_without_normalizing_them(algorithm: str) -> None:
    settings = recipe(algorithm)
    settings.raster_vectorize.tsp_smoothing = 0
    placement = RasterPlacement(x_mm=0, y_mm=0, width_mm=60, height_mm=60)
    measured = []
    for gamma in [0.5, 1, 2]:
        settings.raster_vectorize.single_line_gamma = gamma
        path = single_line.single_line_paths(Image.new("L", (64, 64), 128), settings, placement)[0]
        measured.append(ink_coverage(render_path(path, placement).crop((24, 24, 696, 696))))
    assert measured[0] > measured[1] + 0.1
    assert measured[1] > measured[2] + 0.1
    for actual, expected in zip(measured, [0.705, 0.498, 0.248], strict=True):
        assert abs(actual - expected) < 0.14, measured


@pytest.mark.parametrize("algorithm", ["arc-scribble", "travelling-salesman"])
def test_rendered_features_follow_source_in_page_coordinates(algorithm: str) -> None:
    settings = recipe(algorithm)
    settings.raster_vectorize.tsp_smoothing = 0
    source = Image.open(io.BytesIO(content()))
    placement = RasterPlacement(x_mm=17, y_mm=29, width_mm=80, height_mm=80)
    path = single_line.single_line_paths(source, settings, placement)[0]
    rendered = render_path(path, placement).resize((16, 16), Image.Resampling.BOX)
    target = source.resize((16, 16), Image.Resampling.BOX)
    error = sum(
        abs(a - b) for a, b in zip(list(rendered.getdata()), list(target.getdata()), strict=True)
    )
    assert error / (256 * 255) < 0.12


def test_more_overlap_fills_shadow_space() -> None:
    settings = recipe("arc-scribble")
    placement = RasterPlacement(x_mm=0, y_mm=0, width_mm=60, height_mm=60)
    coverage = []
    for overlap in [0, 1]:
        settings.raster_vectorize.arc_overlap = overlap
        path = single_line.single_line_paths(Image.new("L", (64, 64), 0), settings, placement)[0]
        coverage.append(ink_coverage(render_path(path, placement).crop((24, 24, 696, 696))))
    assert coverage[1] > coverage[0] + 0.03
    assert coverage[1] > 0.9


@pytest.mark.parametrize("algorithm", ["arc-scribble", "travelling-salesman"])
def test_pen_width_and_ink_density_control_coverage(algorithm: str) -> None:
    settings = recipe(algorithm)
    settings.raster_vectorize.tsp_smoothing = 0
    placement = RasterPlacement(x_mm=0, y_mm=0, width_mm=60, height_mm=60)
    source = Image.new("L", (64, 64), 128)
    coverages = []
    lengths = []
    for width in [0.5, 1]:
        settings.pen_palette[0].tip_width_mm = width
        path = single_line.single_line_paths(source, settings, placement)[0]
        lengths.append(sum(math.dist(a, b) for a, b in pairwise(path)))
        coverages.append(ink_coverage(render_path(path, placement, width)))
    assert lengths[0] > lengths[1] * 1.5
    assert abs(coverages[0] - coverages[1]) < 0.1
    settings.raster_vectorize.single_line_ink_density = 0.5
    lighter = single_line.single_line_paths(source, settings, placement)[0]
    assert ink_coverage(render_path(lighter, placement, 1)) < coverages[1] - 0.1


def test_legacy_point_count_no_longer_caps_tone_detail_and_seed_remains_deterministic() -> None:
    settings = recipe("travelling-salesman")
    settings.raster_vectorize.tsp_smoothing = 0
    image = Image.new("L", (64, 64), 80)
    placement = RasterPlacement(x_mm=0, y_mm=0, width_mm=40, height_mm=40)
    first = single_line.single_line_paths(image, settings, placement)
    settings.raster_vectorize.single_line_point_count = 4000
    assert first == single_line.single_line_paths(image, settings, placement)
    settings.mode.seed = "another-seed"
    assert first != single_line.single_line_paths(image, settings, placement)


@pytest.mark.parametrize("algorithm", ALGORITHMS)
def test_single_line_work_is_cooperatively_cancellable(algorithm: str) -> None:
    settings = recipe(algorithm)

    def stop(stage: str, _done: int | None, _total: int | None) -> None:
        if stage in {"spiral-waves", "routing-image-tones"}:
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


@pytest.mark.parametrize("algorithm", ["arc-scribble", "travelling-salesman"])
def test_dense_output_adapts_whole_frame_instead_of_raising(algorithm: str, monkeypatch) -> None:
    monkeypatch.setattr(single_line, "MAX_VERTICES", 1500)
    settings = recipe(algorithm)
    settings.raster_vectorize.arc_overlap = 1
    placement = RasterPlacement(x_mm=0, y_mm=0, width_mm=80, height_mm=80)
    warnings: list[str] = []
    paths = single_line.single_line_paths(
        Image.new("L", (64, 64), 0),
        settings,
        placement,
        warnings=warnings,
    )
    assert len(paths) == 1
    assert len(paths[0]) <= 1500
    assert warnings and "complete image" in warnings[0]
    xs, ys = zip(*paths[0], strict=True)
    assert min(xs) < 2 and min(ys) < 2
    assert max(xs) > 78 and max(ys) > 78
    if algorithm == "travelling-salesman":
        assert single_line.crossing_pair(paths[0]) is None


def test_extreme_arc_settings_finish_within_real_budget() -> None:
    settings = recipe("arc-scribble")
    settings.mode.quality = "export"
    for pen in settings.pen_palette:
        pen.tip_width_mm = 0.1
    settings.raster_vectorize.arc_min_radius_mm = 0.1
    settings.raster_vectorize.arc_max_radius_mm = 12
    settings.raster_vectorize.arc_overlap = 1
    placement = RasterPlacement(x_mm=0, y_mm=0, width_mm=200, height_mm=200)
    warnings: list[str] = []
    path = single_line.single_line_paths(
        Image.new("L", (64, 64), 0),
        settings,
        placement,
        warnings=warnings,
    )[0]
    assert len(path) <= 400_000
    assert warnings
    assert max(x for x, _ in path) > 198 and max(y for _, y in path) > 198
    assert min(x for x, _ in path) < 2 and min(y for _, y in path) < 2


def test_budget_adjustment_reaches_design_diagnostics(monkeypatch) -> None:
    monkeypatch.setattr(single_line, "MAX_VERTICES", 1500)
    document = vectorize_raster(
        content(), "image/png", recipe("arc-scribble"), source_sha256="a" * 64
    )
    assert document.metadata.generator_version == "2.0.0"
    assert any(d.code == "single-line-detail-adapted" for d in document.metadata.diagnostics)


def test_curve_filling_and_retry_are_cancellable(monkeypatch) -> None:
    settings = recipe("arc-scribble")
    placement = RasterPlacement(x_mm=0, y_mm=0, width_mm=80, height_mm=80)
    for target in ["filling-tonal-arcs", "adapting-curve-detail"]:
        monkeypatch.setattr(single_line, "MAX_VERTICES", 2000)

        def stop(stage, _done, _total, target_stage=target):
            if stage == target_stage:
                raise RuntimeError("cancelled")

        with pytest.raises(RuntimeError, match="cancelled"):
            single_line.single_line_paths(Image.new("L", (64, 64), 0), settings, placement, stop)


def test_explicit_pass_mapping_selects_drawing_pen() -> None:
    settings = recipe("arc-scribble")
    settings.pen_palette[0].tip_width_mm = 0.2
    settings.pen_palette[1].tip_width_mm = 0.8
    settings.passes[0].source_layer_ids = ["unrelated-layer"]
    settings.passes[1].source_layer_ids = ["layer-raster-arc-scribble"]
    assert single_line._drawing_pen_width(settings) == 0.8
