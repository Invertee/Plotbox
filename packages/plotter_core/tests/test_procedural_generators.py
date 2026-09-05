from __future__ import annotations

import math

import pytest
from plotter_core.models import ModeSettings, Point, ProjectRecipe
from plotter_core.modes import get_mode_registry
from plotter_core.planning import build_plot_plan

MODE_IDS = [
    "builtin.flow-field",
    "builtin.topographic-contours",
    "builtin.truchet",
    "builtin.guilloche",
]
GOLDEN_HASHES = {
    "builtin.flow-field": "a741df00b0b99ae0c95296cd2fe5b75d292c9ce64e6c5c0f3f28294147ddb112",
    "builtin.topographic-contours": (
        "044135a635b56cf0dc783add9c402aecc109fdbe753e2cd8b7082525168df020"
    ),
    "builtin.truchet": "d6dd1f3d4dee1c75deb0412577b746760e80374a54520c28b12651124f577a7d",
    "builtin.guilloche": "f4d2909df321fc70886cf1d8dcd6f78ae94c796b26e70db6299e85600ff2974c",
}


def _recipe(mode_id: str, *, seed: str = "generator-golden-01", quality: str = "standard"):
    plugin = get_mode_registry().get(mode_id)
    return ProjectRecipe(
        project_id=f"test-{mode_id.rsplit('.', 1)[-1]}",
        name="Generator fixture",
        mode=ModeSettings(
            mode_id=mode_id,
            version=plugin.manifest.version,
            seed=seed,
            quality=quality,  # type: ignore[arg-type]
        ),
    )


def _points(recipe: ProjectRecipe) -> list[Point]:
    design = get_mode_registry().generate(recipe)
    return [
        command.point
        for layer in design.layers
        for path in layer.paths
        for command in path.commands
        if hasattr(command, "point")
    ]


@pytest.mark.parametrize("mode_id", MODE_IDS)
def test_generators_are_deterministic_bounded_and_finite(mode_id: str) -> None:
    recipe = _recipe(mode_id)
    first = get_mode_registry().generate(recipe)
    second = get_mode_registry().generate(recipe)
    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    assert first.metadata.normalized_sha256 == GOLDEN_HASHES[mode_id]
    assert (
        first.metadata.normalized_sha256
        != get_mode_registry()
        .generate(_recipe(mode_id, seed="different-seed"))
        .metadata.normalized_sha256
    )
    low, high = recipe.page.safe_min, recipe.page.safe_max
    points = _points(recipe)
    assert points
    assert all(
        math.isfinite(point.x)
        and math.isfinite(point.y)
        and low.x <= point.x <= high.x
        and low.y <= point.y <= high.y
        for point in points
    )


@pytest.mark.parametrize("mode_id", MODE_IDS)
def test_draft_quality_is_less_complex_than_export(mode_id: str) -> None:
    plugin = get_mode_registry().get(mode_id)
    draft = plugin.estimate(_recipe(mode_id, quality="draft"))
    export = plugin.estimate(_recipe(mode_id, quality="export"))
    assert draft.paths <= export.paths
    assert draft.vertices < export.vertices
    assert draft.relative_work < export.relative_work


@pytest.mark.parametrize("mode_id", MODE_IDS)
def test_generators_feed_both_existing_physical_passes(mode_id: str) -> None:
    recipe = _recipe(mode_id)
    plan = build_plot_plan(recipe, get_mode_registry().generate(recipe))
    assert [plot_pass.semantic_role for plot_pass in plan.passes] == ["structure", "accent"]
    assert all(plot_pass.ordered_paths for plot_pass in plan.passes)


def test_physical_pen_mapping_does_not_change_flow_geometry() -> None:
    recipe = _recipe("builtin.flow-field")
    before = get_mode_registry().generate(recipe).metadata.normalized_sha256
    recipe.passes[0].pen_profile_id = "cyan-05"
    recipe.passes[1].pen_profile_id = "black-05"
    after = get_mode_registry().generate(recipe).metadata.normalized_sha256
    assert before == after


def test_complexity_budget_blocks_before_generation() -> None:
    recipe = _recipe("builtin.flow-field")
    recipe.mode.parameters = {"path_budget": 1, "vertex_budget": 100}
    with pytest.raises(ValueError, match="estimated procedural complexity exceeds"):
        get_mode_registry().generate(recipe)


def test_generator_honors_cancellation_checkpoints() -> None:
    class CancelImmediately:
        cancelled = True

        def checkpoint(self) -> None:
            raise RuntimeError("cancelled")

    with pytest.raises(RuntimeError, match="cancelled"):
        get_mode_registry().generate(
            _recipe("builtin.flow-field"),
            cancellation=CancelImmediately(),
        )


@pytest.mark.parametrize("preset_id", ["curl-ribbons", "noise", "radial", "vortex"])
def test_flow_presets_generate_reproducible_plot_paths(preset_id: str) -> None:
    plugin = get_mode_registry().get("builtin.flow-field")
    preset = next(item for item in plugin.manifest.presets if item.preset_id == preset_id)
    recipe = _recipe("builtin.flow-field")
    recipe.mode = recipe.mode.model_copy(
        update={"parameters": preset.parameters, "seed": preset.seed}
    )
    first = get_mode_registry().generate(recipe)
    second = get_mode_registry().generate(recipe)
    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    assert any(layer.paths for layer in first.layers)
    for point in _points(recipe):
        assert recipe.page.safe_min.x <= point.x <= recipe.page.safe_max.x
        assert recipe.page.safe_min.y <= point.y <= recipe.page.safe_max.y
