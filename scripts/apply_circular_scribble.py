from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text(encoding="utf-8")
    if old not in content:
        raise RuntimeError(f"expected text not found in {path}")
    target.write_text(content.replace(old, new, 1), encoding="utf-8")


replace_once(
    "packages/plotter_core/plotter_core/models.py",
    '        "squiggle",\n        "tone-contour",',
    '        "squiggle",\n        "circular-scribble",\n        "tone-contour",',
)

replace_once(
    "apps/web/src/types.ts",
    '      | "squiggle"\n      | "tone-contour"',
    '      | "squiggle"\n      | "circular-scribble"\n      | "tone-contour"',
)

replace_once(
    "apps/web/src/App.tsx",
    '          <option value="squiggle">Squiggle scanlines</option>\n          <option value="tone-contour">Tone contours</option>',
    '          <option value="squiggle">Squiggle scanlines</option>\n          <option value="circular-scribble">Circular scribble (single line)</option>\n          <option value="tone-contour">Tone contours</option>',
)

circular_controls = '''      {settings.algorithm === "circular-scribble" && (
        <>
          <div className="field-row">
            <label>
              Lane spacing mm
              <input
                aria-label="Circular scribble lane spacing"
                type="number"
                min="0.1"
                step="0.1"
                value={settings.squiggle_spacing_mm}
                onChange={(event) => update({ squiggle_spacing_mm: Number(event.target.value) })}
              />
            </label>
            <label>
              Max swirl radius mm
              <input
                aria-label="Circular scribble maximum swirl radius"
                type="number"
                min="0.1"
                step="0.1"
                value={settings.squiggle_amplitude_mm}
                onChange={(event) => update({ squiggle_amplitude_mm: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Light loop pitch mm
              <input
                aria-label="Circular scribble light loop pitch"
                type="number"
                min="0.2"
                step="0.1"
                value={settings.squiggle_wavelength_mm}
                onChange={(event) => update({ squiggle_wavelength_mm: Number(event.target.value) })}
              />
            </label>
            <label>
              Tone modulation
              <select
                aria-label="Circular scribble tone modulation"
                value={settings.squiggle_modulation}
                onChange={(event) =>
                  update({
                    squiggle_modulation: event.target
                      .value as ProjectRecipe["raster_vectorize"]["squiggle_modulation"],
                  })
                }
              >
                <option value="amplitude">Swirl size</option>
                <option value="frequency">Overlap distance</option>
                <option value="both">Both</option>
              </select>
            </label>
          </div>
          <p className="field-help">
            Emits one continuous plotted path. Darker tones shrink the curls and reduce their
            forward pitch, increasing overlap without lifting the pen.
          </p>
        </>
      )}
'''
replace_once(
    "apps/web/src/App.tsx",
    '      {settings.algorithm === "tone-contour" && (',
    circular_controls + '      {settings.algorithm === "tone-contour" && (',
)

replace_once(
    "packages/plotter_core/plotter_core/importers/raster_vectorize.py",
    'DITHER_VECTORIZER_VERSION = "1.0.0"\n',
    'DITHER_VECTORIZER_VERSION = "1.0.0"\nCIRCULAR_SCRIBBLE_VECTORIZER_VERSION = "1.0.0"\n',
)

circular_algorithm = '''def _circular_scribble_paths(
    image: Image.Image,
    recipe: ProjectRecipe,
    preview: RasterPreview,
    checkpoint: ProgressCallback | None,
) -> VectorizationResult:
    """Trace one tone-aware serpentine path made from overlapping circular loops."""

    settings = recipe.raster_vectorize
    placement = preview.placement
    maximum_radius = min(
        settings.squiggle_amplitude_mm,
        placement.width_mm / 4,
        placement.height_mm / 4,
    )
    if maximum_radius <= 0:
        return VectorizationResult(paths=[], removed_segments=1)

    # Lightweight deterministic variant of circular-scribble synthesis: a virtual serpentine
    # path carries parametric loops whose radius and forward pitch are modulated by source tone.
    minimum_radius = maximum_radius * 0.6
    lane_spacing = max(settings.squiggle_spacing_mm, maximum_radius * 1.8)
    light_pitch = max(0.2, settings.squiggle_wavelength_mm)
    dark_pitch = max(0.2, min(light_pitch, maximum_radius * 1.1))
    segments_per_loop = {"draft": 6, "standard": 8, "export": 10}[recipe.mode.quality]

    min_center_x = placement.x_mm + maximum_radius
    max_center_x = placement.x_mm + placement.width_mm - maximum_radius
    min_center_y = placement.y_mm + maximum_radius
    max_center_y = placement.y_mm + placement.height_mm - maximum_radius
    vertical_span = max_center_y - min_center_y
    row_count = max(1, math.floor(vertical_span / lane_spacing) + 1)
    baselines = (
        [(min_center_y + max_center_y) / 2]
        if row_count == 1
        else [
            min_center_y + vertical_span * row / (row_count - 1)
            for row in range(row_count)
        ]
    )

    pixels = cast(Any, image.load())
    points: list[FloatPoint] = []
    phase = 0.0
    golden_angle = math.pi * (3 - math.sqrt(5))

    def clamp_point(x: float, y: float) -> FloatPoint:
        return (
            min(placement.x_mm + placement.width_mm, max(placement.x_mm, x)),
            min(placement.y_mm + placement.height_mm, max(placement.y_mm, y)),
        )

    def darkness_at(point: FloatPoint) -> float:
        raw_darkness = 1.0 - _sample_luminance(
            pixels,
            image.width,
            image.height,
            placement,
            point,
        ) / 255.0
        floor = settings.squiggle_min_darkness
        if raw_darkness <= floor:
            return 0.0
        return min(1.0, max(0.0, (raw_darkness - floor) / max(1e-9, 1.0 - floor)))

    for row, baseline in enumerate(baselines):
        _checkpoint(checkpoint, "circular-scribble-lanes", row, row_count)
        direction = 1.0 if row % 2 == 0 else -1.0
        center_x = min_center_x if direction > 0 else max_center_x
        end_x = max_center_x if direction > 0 else min_center_x

        while (direction > 0 and center_x <= end_x) or (
            direction < 0 and center_x >= end_x
        ):
            darkness = darkness_at((center_x, baseline))
            radius = (
                maximum_radius - (maximum_radius - minimum_radius) * darkness
                if settings.squiggle_modulation in {"amplitude", "both"}
                else maximum_radius
            )
            pitch = (
                light_pitch - (light_pitch - dark_pitch) * darkness
                if settings.squiggle_modulation in {"frequency", "both"}
                else light_pitch
            )

            for segment in range(segments_per_loop + 1):
                angle = phase + direction * 2 * math.pi * segment / segments_per_loop
                radial_scale = 0.96 + 0.04 * math.sin(
                    3 * angle + row * 0.73 + center_x * 0.031
                )
                loop_radius = radius * radial_scale
                points.append(
                    clamp_point(
                        center_x + loop_radius * math.cos(angle),
                        baseline + loop_radius * math.sin(angle),
                    )
                )

            phase = (phase + direction * golden_angle) % (2 * math.pi)
            center_x += direction * pitch

        if row + 1 < row_count:
            next_baseline = baselines[row + 1]
            turn_x = max_center_x if direction > 0 else min_center_x
            turn_sign = 1.0 if direction > 0 else -1.0
            transition_points = max(3, segments_per_loop // 2)
            for step in range(1, transition_points + 1):
                ratio = step / transition_points
                points.append(
                    clamp_point(
                        turn_x
                        + turn_sign
                        * maximum_radius
                        * 0.55
                        * math.sin(math.pi * ratio),
                        baseline + (next_baseline - baseline) * ratio,
                    )
                )

    _checkpoint(checkpoint, "circular-scribble-lanes", row_count, row_count)
    deduplicated = [
        point
        for index, point in enumerate(points)
        if index == 0 or point != points[index - 1]
    ]
    return VectorizationResult(paths=[deduplicated] if len(deduplicated) >= 2 else [])


'''
replace_once(
    "packages/plotter_core/plotter_core/importers/raster_vectorize.py",
    'def _interpolate(\n',
    circular_algorithm + 'def _interpolate(\n',
)

replace_once(
    "packages/plotter_core/plotter_core/importers/raster_vectorize.py",
    '        elif algorithm == "squiggle":\n            result = _squiggle_paths(image, recipe, preview, checkpoint)\n        elif algorithm == "dither":',
    '        elif algorithm == "squiggle":\n            result = _squiggle_paths(image, recipe, preview, checkpoint)\n        elif algorithm == "circular-scribble":\n            result = _circular_scribble_paths(image, recipe, preview, checkpoint)\n        elif algorithm == "dither":',
)

replace_once(
    "packages/plotter_core/plotter_core/importers/raster_vectorize.py",
    '                DITHER_VECTORIZER_VERSION\n                if algorithm == "dither"\n                else RASTER_VECTORIZER_VERSION',
    '                DITHER_VECTORIZER_VERSION\n                if algorithm == "dither"\n                else CIRCULAR_SCRIBBLE_VECTORIZER_VERSION\n                if algorithm == "circular-scribble"\n                else RASTER_VECTORIZER_VERSION',
)

replace_once(
    "README.md",
    "plot resolution using edge, centerline, hatch, crosshatch, squiggle, tone-contour, or quantized\ncolor-region geometry.",
    "plot resolution using edge, centerline, hatch, crosshatch, squiggle, tone-contour, single-line\ncircular-scribble, or quantized color-region geometry.",
)
replace_once(
    "README.md",
    "Raster vectorization converts that physical preview into a normal `DesignDocument` using one of\nnine deterministic algorithms:",
    "Raster vectorization converts that physical preview into a normal `DesignDocument` using one of\nten deterministic algorithms:",
)
replace_once(
    "README.md",
    "- continuous luminance-modulated squiggle scanlines;\n- multi-level marching-squares tone contours.",
    "- continuous luminance-modulated squiggle scanlines;\n- single-line tone-aware circular scribbles with smaller, more closely spaced loops in darker regions;\n- multi-level marching-squares tone contours.",
)

(ROOT / "packages/plotter_core/tests/test_circular_scribble.py").write_text(
    '''from __future__ import annotations

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

    plan = build_plot_plan(recipe, first)
    assert plan.statistics.path_count == 1


def test_circular_scribble_tone_modulation_changes_geometry() -> None:
    recipe = _recipe()
    content = _gradient_fixture()
    adaptive = vectorize_raster(content, "image/png", recipe, source_sha256="a" * 64)

    recipe.raster_vectorize.squiggle_modulation = "amplitude"
    fixed_pitch = vectorize_raster(content, "image/png", recipe, source_sha256="a" * 64)

    assert adaptive.metadata.normalized_sha256 != fixed_pitch.metadata.normalized_sha256
    assert len(adaptive.layers[0].paths[0].commands) > len(fixed_pitch.layers[0].paths[0].commands)
''',
    encoding="utf-8",
)
