from __future__ import annotations

import json
from pathlib import Path

from plotter_core.glyphscape import generate_glyphscape_composition
from plotter_core.models import ModeSettings, PageSettings, ProjectRecipe
from plotter_core.modes import GenerationContext, QualityLevel, get_mode_registry

ROOT = Path(__file__).resolve().parents[3]


def test_city_circuit_statistical_and_geometry_golden() -> None:
    plugin = get_mode_registry().get("builtin.glyphscape")
    preset = plugin.manifest.presets[0]
    settings = plugin.prepare_settings(
        ModeSettings(
            mode_id=plugin.manifest.id,
            version=plugin.manifest.version,
            seed=preset.seed or "glyphscape-golden",
            quality="standard",
            parameters=preset.parameters,
        )
    )
    recipe = ProjectRecipe(
        project_id="glyphscape-test",
        name="Glyphscape test",
        page=PageSettings(
            preset="custom",
            orientation="landscape",
            width_mm=180,
            height_mm=130,
            margin_mm=8,
        ),
        mode=settings,
    )
    composition = generate_glyphscape_composition(
        GenerationContext(
            recipe=recipe,
            quality=QualityLevel.STANDARD,
            parameters=settings.parameters,
        )
    )
    expected = json.loads(
        (ROOT / "fixtures" / "glyphscape" / "city-circuit.json").read_text(encoding="utf-8")
    )
    actual = composition.statistics.model_dump(mode="json")
    assert actual == expected
