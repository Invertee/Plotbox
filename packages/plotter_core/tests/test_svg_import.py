from __future__ import annotations

import base64
import io
import zipfile
from pathlib import Path

from plotter_core.importers import import_svg
from plotter_core.models import ProjectRecipe
from plotter_core.planning import build_plot_plan, flatten_design_path
from plotter_core.svg_export import export_svg_bundle

ROOT = Path(__file__).resolve().parents[3]


def _fixture() -> bytes:
    return (ROOT / "fixtures" / "svg" / "two-layer-transforms.svg").read_bytes()


def test_svg_import_resolves_physical_units_transforms_use_dashes_and_warnings() -> None:
    recipe = ProjectRecipe(project_id="svg-import", name="SVG import")
    recipe.svg_import.fit_to_page = False
    recipe.svg_import.fill_mode = "hatch"
    design = import_svg(_fixture(), recipe)

    assert [layer.name for layer in design.layers] == ["structure", "accent"]
    assert design.metadata.source_asset_sha256 is not None
    assert {item.code for item in design.metadata.diagnostics} == {"unsupported-filter"}
    structure, accent = design.layers
    assert any("dash" in path.path_id for path in structure.paths)
    assert any("marker" in path.path_id for path in structure.paths)
    assert len(accent.paths) > 5

    all_points = [
        point
        for layer in design.layers
        for path in layer.paths
        for point in flatten_design_path(path, 0.05)
    ]
    assert min(point.x for point in all_points) >= 160 - 1e-6
    assert max(point.x for point in all_points) <= 260 + 1e-6
    assert min(point.y for point in all_points) >= 123.5 - 1e-6
    assert max(point.y for point in all_points) <= 173.5 + 1e-6


def test_svg_text_uses_bundled_deterministic_fixture_font() -> None:
    recipe = ProjectRecipe(project_id="svg-text", name="SVG text")
    recipe.svg_import.fit_to_page = False
    design = import_svg(
        b'<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="10mm">'
        b'<text id="label" x="1" y="8" font-size="7">A1</text></svg>',
        recipe,
    )
    paths = design.layers[0].paths
    assert paths
    assert all(path.closed for path in paths)
    assert {path.metadata["fixture_font"] for path in paths} == {"plotter-5x7-v1"}
    assert design.metadata.diagnostics == []


def test_svg_top_level_parts_can_use_independent_fill_effects() -> None:
    recipe = ProjectRecipe(project_id="svg-effects", name="SVG effects")
    recipe.svg_import.fit_to_page = False
    recipe.svg_import.dot_spacing_mm = 2
    recipe.svg_import.dot_diameter_mm = 0.6
    recipe.svg_import.part_effects = {
        "hatched-panel": {"fill_mode": "crosshatch"},
        "dotted-panel": {"fill_mode": "dots"},
        "organic-panel": {"fill_mode": "stipple"},
    }
    design = import_svg(
        b'<svg xmlns="http://www.w3.org/2000/svg" width="36mm" height="10mm" '
        b'viewBox="0 0 36 10"><rect id="hatched-panel" width="10" height="10"/>'
        b'<rect id="dotted-panel" x="13" width="10" height="10"/>'
        b'<rect id="organic-panel" x="26" width="10" height="10"/></svg>',
        recipe,
    )

    assert [layer.semantic_role for layer in design.layers] == [
        "hatched-panel",
        "dotted-panel",
        "organic-panel",
    ]
    hatched, dotted, organic = design.layers
    assert {path.metadata.get("mark_kind") for path in dotted.paths} == {"pen-dot"}
    assert {path.metadata.get("mark_kind") for path in organic.paths} == {"pen-dot"}
    assert all("crosshatch" in path.path_id or "hatch" in path.path_id for path in hatched.paths)
    assert [path.commands[0].point for path in dotted.paths] != [
        path.commands[0].point for path in organic.paths
    ]
    assert dotted.metadata["fill_effect"] == "dots"
    assert organic.metadata["fill_effect"] == "stipple"


def test_svg_parts_can_override_effect_details_and_drawing_order() -> None:
    recipe = ProjectRecipe(project_id="svg-part-details", name="SVG part details")
    recipe.svg_import.fit_to_page = False
    recipe.svg_import.fill_mode = "dots"
    recipe.svg_import.dot_spacing_mm = 4
    recipe.svg_import.dot_diameter_mm = 0.4
    recipe.svg_import.part_effects = {
        "dense": {
            "dot_spacing_mm": 1,
            "dot_diameter_mm": 0.9,
        },
        "lines": {
            "fill_mode": "crosshatch",
            "hatch_spacing_mm": 1.5,
            "hatch_angle_degrees": 20,
        },
    }
    recipe.svg_import.part_order = ["lines", "dense", "default"]

    design = import_svg(
        b'<svg xmlns="http://www.w3.org/2000/svg" width="30mm" height="10mm" '
        b'viewBox="0 0 30 10"><rect id="default" width="8" height="8"/>'
        b'<rect id="dense" x="10" width="8" height="8"/>'
        b'<rect id="lines" x="20" width="8" height="8"/></svg>',
        recipe,
    )

    assert [layer.semantic_role for layer in design.layers] == ["lines", "dense", "default"]
    lines, dense, default = design.layers
    assert lines.metadata["fill_effect"] == "crosshatch"
    assert len(dense.paths) > len(default.paths)
    assert {path.metadata.get("dot_diameter_mm") for path in dense.paths} == {0.9}
    assert {path.metadata.get("dot_diameter_mm") for path in default.paths} == {0.4}


def test_svg_layers_map_to_passes_without_changing_design_geometry() -> None:
    recipe = ProjectRecipe(project_id="svg-passes", name="SVG passes")
    design = import_svg(_fixture(), recipe)
    recipe.passes = [
        recipe.passes[0].model_copy(
            update={
                "pass_id": "pass-structure",
                "semantic_role": design.layers[0].semantic_role,
                "source_layer_ids": [design.layers[0].layer_id],
            }
        ),
        recipe.passes[1].model_copy(
            update={
                "pass_id": "pass-accent",
                "semantic_role": design.layers[1].semantic_role,
                "source_layer_ids": [design.layers[1].layer_id],
            }
        ),
    ]
    first = build_plot_plan(recipe, design)
    recipe.passes.reverse()
    second = build_plot_plan(recipe, design)
    assert design.metadata.normalized_sha256 == first.source_design_sha256
    assert [item.pass_id for item in second.passes] == ["pass-accent", "pass-structure"]
    assert {path.path_id for plot_pass in first.passes for path in plot_pass.ordered_paths} == {
        path.path_id for plot_pass in second.passes for path in plot_pass.ordered_paths
    }

    bundle = export_svg_bundle(recipe, design)
    archive = zipfile.ZipFile(io.BytesIO(base64.b64decode(bundle.archive_base64)))
    assert archive.namelist() == ["01-cyan.svg", "02-black.svg", "combined.svg"]
    assert b'width="420mm"' in archive.read("combined.svg")
