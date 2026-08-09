from __future__ import annotations

from plotter_core.generator import generate_test_design
from plotter_core.models import ProjectRecipe


def recipe(seed: str = "codex-vertical-slice-1") -> ProjectRecipe:
    return ProjectRecipe(
        project_id="golden-a3",
        name="A3 vertical slice",
        mode={"seed": seed, "quality": "export"},
    )


def test_generator_is_deterministic_with_stable_layer_ids() -> None:
    first = generate_test_design(recipe())
    second = generate_test_design(recipe())
    assert first == second
    assert first.metadata.normalized_sha256 == second.metadata.normalized_sha256
    assert [layer.layer_id for layer in first.layers] == [
        "layer-structure",
        "layer-accent",
    ]
    assert [layer.semantic_role for layer in first.layers] == ["structure", "accent"]


def test_seed_changes_geometry_but_not_layer_contract() -> None:
    first = generate_test_design(recipe("seed-a"))
    second = generate_test_design(recipe("seed-b"))
    assert first.metadata.normalized_sha256 != second.metadata.normalized_sha256
    assert [layer.layer_id for layer in first.layers] == [layer.layer_id for layer in second.layers]


def test_draft_has_less_geometry_than_export() -> None:
    export_recipe = recipe()
    draft_recipe = export_recipe.model_copy(
        update={"mode": export_recipe.mode.model_copy(update={"quality": "draft"})}
    )
    export = generate_test_design(export_recipe)
    draft = generate_test_design(draft_recipe)
    assert sum(len(layer.paths) for layer in draft.layers) < sum(
        len(layer.paths) for layer in export.layers
    )


def test_appearance_parameters_do_not_rearrange_geometry() -> None:
    base = recipe()
    changed = base.model_copy(
        update={
            "mode": base.mode.model_copy(
                update={
                    "parameters": {
                        "accent_color": "#d4512a",
                        "accent_role": "detail",
                    }
                }
            )
        }
    )
    first = generate_test_design(base)
    second = generate_test_design(changed)
    assert [layer.paths for layer in first.layers] == [layer.paths for layer in second.layers]
    assert second.layers[1].preview_color == "#d4512a"
    assert second.layers[1].semantic_role == "detail"
