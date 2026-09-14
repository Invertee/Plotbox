from __future__ import annotations

import json
from pathlib import Path

from plotter_core.generator import generate_test_design
from plotter_core.planning import build_plot_plan
from plotter_core.projects import ProjectStore


def test_project_create_update_cache_and_reopen(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    recipe = store.create("A3 acceptance")
    assert recipe.page.width_mm == 420
    assert recipe.page.height_mm == 297
    assert (store.project_directory(recipe.project_id) / "project.json").exists()

    updated = store.update(
        recipe.project_id,
        {"mode": {"seed": "saved-seed"}, "passes": recipe.model_dump()["passes"]},
    )
    assert updated.revision == 2
    assert updated.mode.seed == "saved-seed"
    reopened = store.read(recipe.project_id)
    assert reopened == updated

    design = generate_test_design(reopened)
    plan = build_plot_plan(reopened, design)
    store.write_design(reopened, design)
    store.write_plan(reopened, design, plan)
    assert store.read_design(reopened) == design
    assert store.read_plan(reopened, design) == plan
    payload = json.loads((store.project_directory(recipe.project_id) / "project.json").read_text())
    assert payload["schema_version"] == 1


def test_reconcile_groups_layers_that_reuse_the_same_pass(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    recipe = store.create("Shared semantic role")
    generated = generate_test_design(recipe)
    structure = generated.layers[0]
    design = generated.model_copy(
        update={
            "layers": [
                structure,
                structure.model_copy(
                    update={"layer_id": "layer-structure-second", "name": "Structure second"}
                ),
            ]
        }
    )

    reconciled = store.reconcile_passes(recipe, design)

    assert [plot_pass.pass_id for plot_pass in reconciled.passes] == ["pass-black"]
    assert reconciled.passes[0].source_layer_ids == [
        structure.layer_id,
        "layer-structure-second",
    ]


def test_project_delete_removes_only_the_selected_project(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    first = store.create("First")
    second = store.create("Second")
    shared_cache = tmp_path / "_osm-query-cache"
    shared_cache.mkdir()
    (shared_cache / "keep.txt").write_text("shared", encoding="utf-8")
    first_directory = store.project_directory(first.project_id)
    (first_directory / "exports" / "plot.nc").write_text("M2\n", encoding="utf-8")

    store.delete(first.project_id)

    assert not first_directory.exists()
    assert store.read(second.project_id) == second
    assert (shared_cache / "keep.txt").read_text(encoding="utf-8") == "shared"


def test_project_delete_rejects_invalid_or_missing_ids(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    try:
        store.delete("../outside")
    except ValueError as error:
        assert "invalid project ID" in str(error)
    else:
        raise AssertionError("path traversal project ID was accepted")

    try:
        store.delete("missing-project")
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("missing project deletion succeeded")
