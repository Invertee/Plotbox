from __future__ import annotations

import json
import os
import time
from pathlib import Path

from plotter_core.cache import NodeCache, node_cache_key
from plotter_core.generator import generate_test_design
from plotter_core.projects import ProjectStore


def test_node_cache_key_is_stable_and_quality_sensitive() -> None:
    common = {
        "operator_name": "import.svg",
        "operator_version": "1.0.0",
        "input_content_hash": "a" * 64,
        "parameters": {"fill": "hatch", "spacing": 2},
    }
    first = node_cache_key(**common, quality="draft")
    second = node_cache_key(**common, quality="draft")
    export = node_cache_key(**common, quality="export")
    assert first == second
    assert first != export


def test_node_cache_reports_hits_and_prunes_lru_entries(tmp_path: Path) -> None:
    cache = NodeCache(tmp_path)
    old_key = "1" * 64
    new_key = "2" * 64
    cache.put_json(old_key, {"value": "old"})
    cache.put_json(new_key, {"value": "new"})
    old_metadata = cache.root / f"{old_key}.meta.json"
    old_time = time.time() - 100
    metadata = json.loads(old_metadata.read_text(encoding="utf-8"))
    metadata["last_accessed_at_epoch"] = old_time
    old_metadata.write_text(json.dumps(metadata), encoding="utf-8")
    os.utime(old_metadata, (old_time, old_time))
    assert cache.get_json(new_key) == {"value": "new"}
    report = cache.prune(max_age_seconds=50, max_bytes=20)
    assert report.removed_entries == 1
    assert cache.get_json(old_key) is None
    assert cache.get_json(new_key) == {"value": "new"}


def test_pass_changes_do_not_change_design_cache_identity(tmp_path: Path) -> None:
    store = ProjectStore(tmp_path)
    recipe = store.create("cache identity")
    design = generate_test_design(recipe)
    store.write_design(recipe, design)
    changed = store.update(
        recipe.project_id,
        {"passes": list(reversed([item.model_dump(mode="json") for item in recipe.passes]))},
    )
    assert store.design_cache_path(recipe) == store.design_cache_path(changed)
    assert store.read_design(changed) == design
