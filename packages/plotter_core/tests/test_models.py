from __future__ import annotations

import pytest
from plotter_core.migrations import migrate_project
from plotter_core.models import (
    MachineProfile,
    NormalizedCrop,
    PageSettings,
    ProjectRecipe,
    RasterPreprocessSettings,
    RasterVectorizeSettings,
)
from pydantic import ValidationError


def test_recipe_round_trip_preserves_versioned_contract() -> None:
    recipe = ProjectRecipe(project_id="round-trip", name="Round trip")
    restored = ProjectRecipe.model_validate_json(recipe.model_dump_json())
    assert restored == recipe
    assert restored.page == PageSettings()
    assert [plot_pass.semantic_role for plot_pass in restored.passes] == [
        "structure",
        "accent",
    ]
    assert [pen.pen_id for pen in restored.pen_palette] == ["black-05", "cyan-05"]


def test_future_project_schema_is_rejected() -> None:
    payload = ProjectRecipe(project_id="future", name="Future").model_dump(mode="json")
    payload["schema_version"] = 2
    with pytest.raises(ValueError, match="unsupported future"):
        migrate_project(payload)


def test_unknown_model_fields_are_rejected() -> None:
    payload = MachineProfile().model_dump(mode="json")
    payload["network_address"] = "192.0.2.1"
    with pytest.raises(ValidationError, match="network_address"):
        MachineProfile.model_validate(payload)


def test_invalid_safe_area_is_rejected() -> None:
    with pytest.raises(ValidationError, match="safe drawing area"):
        PageSettings(width_mm=50, height_mm=40, margin_mm=20)


def test_invalid_raster_crop_and_even_adaptive_window_are_rejected() -> None:
    with pytest.raises(ValidationError, match="remain inside"):
        NormalizedCrop(x=0.75, width=0.5)
    with pytest.raises(ValidationError, match="must be odd"):
        RasterPreprocessSettings(adaptive_window_px=10)


def test_crosshatch_thresholds_must_descend() -> None:
    with pytest.raises(ValueError, match="strictly descending"):
        RasterVectorizeSettings(crosshatch_thresholds=(210, 160, 180, 60))
