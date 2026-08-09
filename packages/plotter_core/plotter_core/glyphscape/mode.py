from __future__ import annotations

from typing import cast

from plotter_core.glyphscape.composition import generate_glyphscape
from plotter_core.modes.base import (
    BuiltinModePlugin,
    ComplexityEstimate,
    GenerationContext,
    ModeManifest,
    ModeParameter,
    ModeParameterGroup,
    ModeParameterOption,
    ModePreset,
    QualityLevel,
    QualityMapping,
)

MODE_ID = "builtin.glyphscape"
MODE_VERSION = "1.0.0"


def _option(value: str, label: str) -> ModeParameterOption:
    return ModeParameterOption(value=value, label=label)


def glyphscape_manifest() -> ModeManifest:
    groups = [
        ModeParameterGroup(
            group_id="composition",
            label="Composition",
            description="Macro layout, theme, density, and deterministic regional regeneration.",
        ),
        ModeParameterGroup(
            group_id="network",
            label="Connection network",
            description="Capacity-aware graph, route, and connector-decoration controls.",
        ),
        ModeParameterGroup(
            group_id="physical",
            label="Physical detail",
            description=(
                "Minimum reproducible feature, clearance, and glyph envelopes in millimetres."
            ),
        ),
        ModeParameterGroup(
            group_id="limits",
            label="Complexity limits",
            description="Lower-priority detail and filling stop at these explicit limits.",
        ),
    ]
    parameters = [
        ModeParameter(
            key="seed",
            label="Deterministic seed",
            kind="seed",
            group="composition",
            default="glyphscape-city-1",
        ),
        ModeParameter(
            key="composition",
            label="Macro composition",
            kind="enum",
            group="composition",
            default="uniform-circuit",
            options=[
                _option("uniform-circuit", "Uniform circuit"),
                _option("bottom-skyline", "Bottom skyline"),
                _option("central-island", "Central island"),
                _option("dense-perimeter", "Dense perimeter"),
            ],
        ),
        ModeParameter(
            key="theme",
            label="Theme",
            kind="enum",
            group="composition",
            default="city",
            options=[
                _option("city", "City and architecture"),
                _option("industrial", "Industrial machinery"),
                _option("fairground", "Fairground and circus"),
                _option("mixed", "Mixed"),
            ],
        ),
        ModeParameter(
            key="density",
            label="Glyph density",
            kind="number",
            group="composition",
            default=0.68,
            minimum=0.1,
            maximum=1,
            step=0.05,
        ),
        ModeParameter(
            key="whitespace",
            label="Deliberate whitespace",
            kind="number",
            group="composition",
            default=0.25,
            minimum=0,
            maximum=1,
            step=0.05,
        ),
        ModeParameter(
            key="landmark_count",
            label="Landmarks",
            kind="integer",
            group="composition",
            default=3,
            minimum=1,
            maximum=6,
            step=1,
        ),
        ModeParameter(
            key="orientation_degrees",
            label="Preferred orientation",
            kind="number",
            group="composition",
            default=0,
            minimum=-180,
            maximum=180,
            step=5,
            unit="degrees",
        ),
        ModeParameter(
            key="locked_region",
            label="Locked region",
            kind="enum",
            group="composition",
            default="none",
            description="A locked region keeps its hierarchical seed while regeneration advances.",
            options=[
                _option("none", "None"),
                *[_option(f"region-{index}", f"Region {index + 1}") for index in range(9)],
            ],
        ),
        ModeParameter(
            key="regeneration_step",
            label="Regional regeneration step",
            kind="integer",
            group="composition",
            default=0,
            minimum=0,
            maximum=10000,
            step=1,
        ),
        ModeParameter(
            key="connector_density",
            label="Connector density",
            kind="number",
            group="network",
            default=0.72,
            minimum=0,
            maximum=1,
            step=0.05,
        ),
        ModeParameter(
            key="loopiness",
            label="Loopiness",
            kind="number",
            group="network",
            default=0.3,
            minimum=0,
            maximum=1,
            step=0.05,
        ),
        ModeParameter(
            key="routing_style",
            label="Routing style",
            kind="enum",
            group="network",
            default="orthogonal",
            options=[
                _option("orthogonal", "Orthogonal"),
                _option("eight-direction", "Eight direction"),
            ],
        ),
        ModeParameter(
            key="connector_style",
            label="Connector decoration",
            kind="enum",
            group="network",
            default="mixed",
            options=[
                _option("mixed", "Port-preferred mix"),
                _option("single", "Single line"),
                _option("double", "Double line"),
                _option("wave", "Wave"),
                _option("zigzag", "Zigzag"),
                _option("ladder", "Ladder"),
                _option("beads", "Bead chain"),
                _option("bundle", "Cable bundle"),
            ],
        ),
        ModeParameter(
            key="corner_style",
            label="Route corners",
            kind="enum",
            group="network",
            default="sharp",
            options=[
                _option("sharp", "Sharp"),
                _option("rounded", "Rounded curves"),
            ],
        ),
        ModeParameter(
            key="route_corridor_mm",
            label="Route corridor",
            kind="number",
            group="network",
            default=4.0,
            minimum=1.5,
            maximum=12,
            step=0.5,
            unit="mm",
        ),
        ModeParameter(
            key="filler_density",
            label="Negative-space filling",
            kind="number",
            group="network",
            default=0.35,
            minimum=0,
            maximum=1,
            step=0.05,
        ),
        ModeParameter(
            key="minimum_glyph_size_mm",
            label="Minimum glyph size",
            kind="number",
            group="physical",
            default=12,
            minimum=9,
            maximum=40,
            step=1,
            unit="mm",
        ),
        ModeParameter(
            key="maximum_glyph_size_mm",
            label="Maximum glyph size",
            kind="number",
            group="physical",
            default=30,
            minimum=16,
            maximum=70,
            step=1,
            unit="mm",
        ),
        ModeParameter(
            key="detail_level",
            label="Glyph detail",
            kind="integer",
            group="physical",
            default=3,
            minimum=1,
            maximum=5,
            step=1,
        ),
        ModeParameter(
            key="minimum_feature_mm",
            label="Minimum feature",
            kind="number",
            group="physical",
            default=0.8,
            minimum=0.4,
            maximum=3,
            step=0.1,
            unit="mm",
        ),
        ModeParameter(
            key="minimum_gap_mm",
            label="Minimum clearance",
            kind="number",
            group="physical",
            default=1.2,
            minimum=0.4,
            maximum=6,
            step=0.2,
            unit="mm",
        ),
        ModeParameter(
            key="path_budget",
            label="Maximum paths",
            kind="integer",
            group="limits",
            default=4000,
            minimum=20,
            maximum=50000,
            step=100,
        ),
        ModeParameter(
            key="vertex_budget",
            label="Maximum vertices",
            kind="integer",
            group="limits",
            default=200000,
            minimum=200,
            maximum=1000000,
            step=1000,
        ),
    ]
    common = {
        "connector_density": 0.72,
        "loopiness": 0.3,
        "routing_style": "orthogonal",
        "connector_style": "mixed",
        "corner_style": "sharp",
        "route_corridor_mm": 4.0,
        "filler_density": 0.35,
        "minimum_glyph_size_mm": 12,
        "maximum_glyph_size_mm": 30,
        "detail_level": 3,
        "minimum_feature_mm": 0.8,
        "minimum_gap_mm": 1.2,
        "path_budget": 4000,
        "vertex_budget": 200000,
        "locked_region": "none",
        "regeneration_step": 0,
        "orientation_degrees": 0,
    }
    presets = [
        ModePreset(
            preset_id="city-circuit",
            version=1,
            mode_id=MODE_ID,
            mode_version=MODE_VERSION,
            name="City Circuit",
            description="Architectural landmarks in a dense circuit-board composition.",
            parameter_schema_version=1,
            seed="glyphscape-city-1",
            parameters={
                **common,
                "composition": "uniform-circuit",
                "theme": "city",
                "density": 0.72,
                "whitespace": 0.18,
                "landmark_count": 3,
            },
        ),
        ModePreset(
            preset_id="industrial-skyline",
            version=1,
            mode_id=MODE_ID,
            mode_version=MODE_VERSION,
            name="Industrial Skyline",
            description="Factories, cranes, tanks, and machinery weighted to a lower skyline.",
            parameter_schema_version=1,
            seed="glyphscape-industrial-1",
            parameters={
                **common,
                "composition": "bottom-skyline",
                "theme": "industrial",
                "density": 0.68,
                "whitespace": 0.5,
                "landmark_count": 4,
                "connector_style": "ladder",
            },
        ),
        ModePreset(
            preset_id="fairground-island",
            version=1,
            mode_id=MODE_ID,
            mode_version=MODE_VERSION,
            name="Fairground Island",
            description="A central fairground landmark cluster with playful routed decoration.",
            parameter_schema_version=1,
            seed="glyphscape-fairground-1",
            parameters={
                **common,
                "composition": "central-island",
                "theme": "fairground",
                "density": 0.62,
                "whitespace": 0.32,
                "landmark_count": 3,
                "connector_style": "wave",
            },
        ),
        ModePreset(
            preset_id="mixed-perimeter",
            version=1,
            mode_id=MODE_ID,
            mode_version=MODE_VERSION,
            name="Mixed Perimeter",
            description="Mixed themed glyphs preserve an open central field.",
            parameter_schema_version=1,
            seed="glyphscape-mixed-1",
            parameters={
                **common,
                "composition": "dense-perimeter",
                "theme": "mixed",
                "density": 0.75,
                "whitespace": 0.55,
                "landmark_count": 4,
                "loopiness": 0.45,
            },
        ),
    ]
    return ModeManifest(
        id=MODE_ID,
        version=MODE_VERSION,
        name="Glyphscape",
        description=(
            "Hierarchical city, industrial, and fairground glyphs with "
            "port-aware routed connectors."
        ),
        category="procedural",
        quality_levels=list(QualityLevel),
        semantic_roles=[
            "glyph-structure",
            "glyph-detail",
            "glyph-accent",
            "connector-primary",
            "connector-secondary",
            "connector-junction",
            "filler",
        ],
        parameter_schema_version=1,
        parameter_groups=groups,
        parameters=parameters,
        presets=presets,
        quality_mappings={
            QualityLevel.DRAFT: QualityMapping(
                density_scale=0.55,
                sampling_scale=0.7,
                label="Fast regional layout",
            ),
            QualityLevel.STANDARD: QualityMapping(
                density_scale=0.78,
                sampling_scale=0.85,
                label="Balanced routed composition",
            ),
            QualityLevel.EXPORT: QualityMapping(
                density_scale=1,
                sampling_scale=1,
                label="Full physical detail",
            ),
        },
        default_complexity=ComplexityEstimate(paths=900, vertices=24000, relative_work=4.5),
        algorithms=[
            "macro regions",
            "landmark-first packing",
            "capacity-aware backbone",
            "A* occupancy routing",
            "corridor-bounded connector decoration",
            "negative-space filling",
        ],
    )


def estimate_glyphscape(context: GenerationContext) -> ComplexityEstimate:
    density = float(cast(int | float, context.parameters["density"]))
    quality = {
        QualityLevel.DRAFT: 0.55,
        QualityLevel.STANDARD: 0.78,
        QualityLevel.EXPORT: 1.0,
    }[context.quality]
    requested_paths = round(900 * density * quality)
    requested_vertices = round(24000 * density * quality)
    path_budget = cast(int, context.parameters["path_budget"])
    vertex_budget = cast(int, context.parameters["vertex_budget"])
    return ComplexityEstimate(
        paths=min(path_budget, requested_paths),
        vertices=min(vertex_budget, requested_vertices),
        relative_work=round(4.5 * density * quality, 3),
    )


def glyphscape_plugin() -> BuiltinModePlugin:
    return BuiltinModePlugin(
        manifest=glyphscape_manifest(),
        generator=generate_glyphscape,
        parameter_migrations={},
        complexity_estimator=estimate_glyphscape,
    )
