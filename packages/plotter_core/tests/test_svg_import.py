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
