from __future__ import annotations

import json
from importlib.resources import files

from plotter_core.generator import GENERATOR_ID, GENERATOR_VERSION, generate_test_design_context
from plotter_core.modes.base import (
    BuiltinModePlugin,
    ComplexityEstimate,
    ModeManifest,
    ModeParameter,
    ModeParameterGroup,
    ModeParameterOption,
    ModePreset,
    QualityLevel,
    QualityMapping,
)
from plotter_core.modes.generators import (
    estimate_flow,
    estimate_guilloche,
    estimate_topographic,
    estimate_truchet,
    generate_flow,
    generate_guilloche,
    generate_topographic,
    generate_truchet,
)


def _load_presets(filename: str) -> list[ModePreset]:
    resource = files("plotter_core.modes.presets").joinpath(filename)
    payload = json.loads(resource.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        raise ValueError(f"preset file {filename} must contain a list")
    return [ModePreset.model_validate(item) for item in payload]


def test_pattern_manifest() -> ModeManifest:
    return ModeManifest(
        id=GENERATOR_ID,
        version=GENERATOR_VERSION,
        name="Deterministic two-layer test pattern",
        description="Rounded structures, routed corridors, orbit accents, and signal curves.",
        quality_levels=[
            QualityLevel.DRAFT,
            QualityLevel.STANDARD,
            QualityLevel.EXPORT,
        ],
        semantic_roles=["structure", "accent", "detail"],
        parameter_schema_version=1,
        parameter_groups=[
            ModeParameterGroup(
                group_id="composition",
                label="Composition",
                description="Deterministic geometry layout and density.",
            ),
            ModeParameterGroup(
                group_id="appearance",
                label="Appearance",
                description="Semantic role and preview styling.",
            ),
        ],
        parameters=[
            ModeParameter(
                key="seed",
                label="Deterministic seed",
                kind="seed",
                group="composition",
                default="codex-vertical-slice-1",
                description="Named layout and detail streams isolate geometry changes.",
            ),
            ModeParameter(
                key="density",
                label="Density",
                kind="number",
                group="composition",
                default=1.0,
                minimum=0.25,
                maximum=2.0,
                step=0.05,
            ),
            ModeParameter(
                key="frame_count",
                label="Frame count",
                kind="integer",
                group="composition",
                default=4,
                minimum=1,
                maximum=8,
                step=1,
            ),
            ModeParameter(
                key="include_waves",
                label="Include signal waves",
                kind="boolean",
                group="composition",
                default=True,
            ),
            ModeParameter(
                key="accent_style",
                label="Accent style",
                kind="enum",
                group="composition",
                default="both",
                options=[
                    ModeParameterOption(value="both", label="Orbits and signals"),
                    ModeParameterOption(value="orbits", label="Orbits only"),
                    ModeParameterOption(value="signals", label="Signals only"),
                ],
            ),
            ModeParameter(
                key="orbit_band_mm",
                label="Orbit vertical band",
                kind="range",
                group="composition",
                default=[-38.0, 38.0],
                minimum=-80,
                maximum=80,
                step=1,
                unit="mm",
            ),
            ModeParameter(
                key="accent_color",
                label="Accent preview color",
                kind="color",
                group="appearance",
                default="#00a6c8",
            ),
            ModeParameter(
                key="accent_role",
                label="Accent semantic role",
                kind="role",
                group="appearance",
                default="accent",
                options=[
                    ModeParameterOption(value="accent", label="Accent"),
                    ModeParameterOption(value="detail", label="Detail"),
                ],
            ),
        ],
        presets=_load_presets("test-pattern.json"),
    )


def test_pattern_plugin() -> BuiltinModePlugin:
    return BuiltinModePlugin(
        manifest=test_pattern_manifest(),
        generator=generate_test_design_context,
        parameter_migrations={},
    )


def _quality_mappings() -> dict[QualityLevel, QualityMapping]:
    return {
        QualityLevel.DRAFT: QualityMapping(
            density_scale=0.45, sampling_scale=0.7, label="Fast composition preview"
        ),
        QualityLevel.STANDARD: QualityMapping(
            density_scale=0.72, sampling_scale=0.85, label="Balanced editing detail"
        ),
        QualityLevel.EXPORT: QualityMapping(
            density_scale=1.0, sampling_scale=1.0, label="Full plot detail"
        ),
    }


def _groups() -> list[ModeParameterGroup]:
    return [
        ModeParameterGroup(group_id="composition", label="Composition"),
        ModeParameterGroup(
            group_id="limits",
            label="Complexity limits",
            description="Generation stops before exceeding either explicit budget.",
        ),
    ]


def _seed() -> ModeParameter:
    return ModeParameter(
        key="seed",
        label="Deterministic seed",
        kind="seed",
        group="composition",
        default="plotterapp-procedural-1",
    )


def _budgets() -> list[ModeParameter]:
    return [
        ModeParameter(
            key="path_budget",
            label="Maximum paths",
            kind="integer",
            group="limits",
            default=5000,
            minimum=1,
            maximum=50000,
            step=100,
        ),
        ModeParameter(
            key="vertex_budget",
            label="Maximum vertices",
            kind="integer",
            group="limits",
            default=250000,
            minimum=100,
            maximum=1000000,
            step=1000,
        ),
    ]


def flow_field_plugin() -> BuiltinModePlugin:
    manifest = ModeManifest(
        id="builtin.flow-field",
        version="1.0.0",
        name="Flow Field",
        description="Streamlines follow noise, curl, radial, or vortex vector fields.",
        quality_levels=list(QualityLevel),
        semantic_roles=["structure", "accent"],
        parameter_groups=_groups(),
        parameters=[
            _seed(),
            ModeParameter(
                key="field",
                label="Vector field",
                kind="enum",
                group="composition",
                default="curl",
                options=[
                    ModeParameterOption(value="noise", label="Noise"),
                    ModeParameterOption(value="curl", label="Curl"),
                    ModeParameterOption(value="radial", label="Radial"),
                    ModeParameterOption(value="vortex", label="Vortex"),
                ],
            ),
            ModeParameter(
                key="density",
                label="Streamline density",
                kind="number",
                group="composition",
                default=1.0,
                minimum=0.2,
                maximum=2.5,
                step=0.1,
            ),
            ModeParameter(
                key="step_mm",
                label="Integration step",
                kind="number",
                group="composition",
                default=2.0,
                minimum=0.5,
                maximum=8,
                step=0.25,
                unit="mm",
            ),
            ModeParameter(
                key="spacing_mm",
                label="Collision spacing",
                kind="number",
                group="composition",
                default=2.5,
                minimum=0.2,
                maximum=15,
                step=0.25,
                unit="mm",
            ),
            *_budgets(),
        ],
        presets=_load_presets("flow-field.json"),
        quality_mappings=_quality_mappings(),
        default_complexity=ComplexityEstimate(paths=120, vertices=7200, relative_work=1),
    )
    return BuiltinModePlugin(manifest, generate_flow, {}, estimate_flow)


def topographic_plugin() -> BuiltinModePlugin:
    manifest = ModeManifest(
        id="builtin.topographic-contours",
        version="1.0.0",
        name="Topographic Contours",
        description="Layered deterministic terrain isolines with major contour emphasis.",
        quality_levels=list(QualityLevel),
        semantic_roles=["structure", "accent"],
        parameter_groups=_groups(),
        parameters=[
            _seed(),
            ModeParameter(
                key="levels",
                label="Contour levels",
                kind="integer",
                group="composition",
                default=18,
                minimum=3,
                maximum=80,
                step=1,
            ),
            ModeParameter(
                key="warp",
                label="Terrain warp",
                kind="number",
                group="composition",
                default=0.65,
                minimum=0,
                maximum=2,
                step=0.05,
            ),
            *_budgets(),
        ],
        presets=_load_presets("topographic-contours.json"),
        quality_mappings=_quality_mappings(),
        default_complexity=ComplexityEstimate(paths=18, vertices=3240, relative_work=1),
    )
    return BuiltinModePlugin(manifest, generate_topographic, {}, estimate_topographic)


def truchet_plugin() -> BuiltinModePlugin:
    manifest = ModeManifest(
        id="builtin.truchet",
        version="1.0.0",
        name="Truchet Tiles",
        description="Locally compatible quarter-turn paths form a deterministic tiled network.",
        quality_levels=list(QualityLevel),
        semantic_roles=["structure", "accent"],
        parameter_groups=_groups(),
        parameters=[
            _seed(),
            ModeParameter(
                key="tile_size_mm",
                label="Tile size",
                kind="number",
                group="composition",
                default=18.0,
                minimum=5,
                maximum=60,
                step=1,
                unit="mm",
            ),
            ModeParameter(
                key="mutation",
                label="Tile mutation",
                kind="number",
                group="composition",
                default=0.18,
                minimum=0,
                maximum=1,
                step=0.05,
            ),
            *_budgets(),
        ],
        presets=_load_presets("truchet.json"),
        quality_mappings=_quality_mappings(),
        default_complexity=ComplexityEstimate(paths=240, vertices=3360, relative_work=1),
    )
    return BuiltinModePlugin(manifest, generate_truchet, {}, estimate_truchet)


def guilloche_plugin() -> BuiltinModePlugin:
    manifest = ModeManifest(
        id="builtin.guilloche",
        version="1.0.0",
        name="Guilloché",
        description="Interlaced Lissajous, harmonograph, and trochoid curve families.",
        quality_levels=list(QualityLevel),
        semantic_roles=["structure", "accent"],
        parameter_groups=_groups(),
        parameters=[
            _seed(),
            ModeParameter(
                key="family",
                label="Curve family",
                kind="enum",
                group="composition",
                default="lissajous",
                options=[
                    ModeParameterOption(value="lissajous", label="Lissajous"),
                    ModeParameterOption(value="harmonograph", label="Harmonograph"),
                    ModeParameterOption(value="epitrochoid", label="Epitrochoid"),
                    ModeParameterOption(value="hypotrochoid", label="Hypotrochoid"),
                    ModeParameterOption(value="rosette", label="Rosette"),
                ],
            ),
            ModeParameter(
                key="frequency",
                label="Frequency",
                kind="number",
                group="composition",
                default=3.0,
                minimum=1,
                maximum=16,
                step=0.25,
            ),
            ModeParameter(
                key="phase_degrees",
                label="Phase",
                kind="number",
                group="composition",
                default=30.0,
                minimum=0,
                maximum=360,
                step=1,
                unit="degrees",
            ),
            ModeParameter(
                key="repetitions",
                label="Repetitions",
                kind="integer",
                group="composition",
                default=12,
                minimum=1,
                maximum=80,
                step=1,
            ),
            ModeParameter(
                key="samples",
                label="Samples per curve",
                kind="integer",
                group="composition",
                default=500,
                minimum=50,
                maximum=4000,
                step=50,
            ),
            *_budgets(),
        ],
        presets=_load_presets("guilloche.json"),
        quality_mappings=_quality_mappings(),
        default_complexity=ComplexityEstimate(paths=12, vertices=6000, relative_work=1),
    )
    return BuiltinModePlugin(manifest, generate_guilloche, {}, estimate_guilloche)
