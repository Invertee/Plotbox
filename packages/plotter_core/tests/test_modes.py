from __future__ import annotations

from plotter_core.models import ModeSettings, ProjectRecipe
from plotter_core.modes import ModeManifest, ModeParameter, ModeParameterGroup, QualityLevel
from plotter_core.modes.base import BuiltinModePlugin
from plotter_core.modes.registry import ModeRegistry, get_mode_registry


def test_builtin_manifest_covers_common_controls_and_file_presets() -> None:
    manifest = get_mode_registry().get("builtin.test-pattern").manifest
    assert manifest.schema_version == 1
    assert manifest.parameter_schema_version == 1
    assert {parameter.kind for parameter in manifest.parameters} == {
        "number",
        "integer",
        "boolean",
        "enum",
        "seed",
        "color",
        "role",
        "range",
    }
    assert [preset.preset_id for preset in manifest.presets] == [
        "balanced",
        "quiet-signals",
    ]


def test_mode_settings_are_defaulted_and_invalid_values_are_rejected() -> None:
    plugin = get_mode_registry().get("builtin.test-pattern")
    prepared = plugin.prepare_settings(ModeSettings())
    assert prepared.parameters["density"] == 1.0
    assert prepared.parameters["orbit_band_mm"] == [-38.0, 38.0]

    invalid = prepared.model_copy(update={"parameters": {**prepared.parameters, "density": 99.0}})
    try:
        plugin.prepare_settings(invalid)
    except ValueError as error:
        assert "density must be at most 2.0" in str(error)
    else:
        raise AssertionError("out-of-range mode parameters must be rejected")


def test_parameter_schema_migration_runs_before_validation() -> None:
    manifest = ModeManifest(
        id="builtin.migration-fixture",
        version="1.0.0",
        name="Migration fixture",
        quality_levels=[QualityLevel.STANDARD],
        parameter_schema_version=2,
        parameter_groups=[ModeParameterGroup(group_id="main", label="Main")],
        parameters=[
            ModeParameter(
                key="density",
                label="Density",
                kind="number",
                group="main",
                default=1.0,
                minimum=0.0,
                maximum=2.0,
            )
        ],
    )
    plugin = BuiltinModePlugin(
        manifest=manifest,
        generator=lambda context: (_ for _ in ()).throw(AssertionError(context)),
        parameter_migrations={
            1: lambda parameters: {
                "density": parameters.get("legacy_density", 1.0),
            }
        },
    )
    migrated = plugin.prepare_settings(
        ModeSettings(
            mode_id=manifest.id,
            version=manifest.version,
            quality="standard",
            parameter_schema_version=1,
            parameters={"legacy_density": 1.5},
        )
    )
    assert migrated.parameter_schema_version == 2
    assert migrated.parameters == {"density": 1.5}


def test_registry_rejects_duplicates_and_generates_design_documents() -> None:
    registry = ModeRegistry()
    plugin = get_mode_registry().get("builtin.test-pattern")
    registry.register(plugin)
    try:
        registry.register(plugin)
    except ValueError as error:
        assert "already registered" in str(error)
    else:
        raise AssertionError("duplicate mode registration must fail")

    design = registry.generate(
        ProjectRecipe(project_id="mode-test", name="Mode test"),
    )
    assert design.metadata.generator_id == "builtin.test-pattern"
    assert design.layers[0].semantic_role == "structure"
