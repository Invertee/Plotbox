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
