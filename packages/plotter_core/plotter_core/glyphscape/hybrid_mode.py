from __future__ import annotations

from collections.abc import Mapping
from typing import Any, cast

from plotter_core.glyphscape.hybrid_composition import (
    HYBRID_MODE_ID,
    HYBRID_MODE_VERSION,
    generate_map_glyphscape,
)
from plotter_core.models import DesignDocument, ProjectRecipe
from plotter_core.modes.base import (
    BuiltinModePlugin,
    CancellationSignal,
    ComplexityEstimate,
    GenerationContext,
    ModeManifest,
    ModeParameter,
    ModeParameterGroup,
    ModeParameterOption,
    ModePreset,
    ProgressCallback,
    QualityLevel,
    QualityMapping,
)


def _option(value: str, label: str) -> ModeParameterOption:
    return ModeParameterOption(value=value, label=label)


def map_glyphscape_manifest() -> ModeManifest:
    groups = [
        ModeParameterGroup(
            group_id="map",
            label="Map fidelity",
            description="Source replacement, topology fidelity, and landscape behavior.",
        ),
        ModeParameterGroup(
            group_id="composition",
            label="Glyph composition",
            description="Theme, landmarks, building replacement, and road attachment.",
        ),
        ModeParameterGroup(
            group_id="network",
            label="Hybrid network",
            description="Secondary routing and physical connector decoration.",
        ),
        ModeParameterGroup(
            group_id="limits",
            label="Complexity limits",
            description="Explicit path and vertex ceilings for hybrid output.",
        ),
    ]
    parameters = [
        ModeParameter(
            key="seed",
            label="Deterministic seed",
            kind="seed",
            group="composition",
            default="map-glyphscape-1",
        ),
        ModeParameter(
            key="geographic_fidelity",
            label="Geographic fidelity",
            kind="number",
            group="map",
            default=80,
            minimum=0,
            maximum=100,
            step=5,
            unit="%",
        ),
        ModeParameter(
            key="water_behavior",
            label="Water",
            kind="enum",
            group="map",
            default="exclude",
            options=[
                _option("exclude", "Exclude composition"),
                _option("fill", "Use as filler"),
                _option("ignore", "Ignore"),
            ],
        ),
        ModeParameter(
            key="park_behavior",
            label="Parks",
            kind="enum",
            group="map",
            default="fill",
            options=[
                _option("exclude", "Exclude composition"),
                _option("fill", "Use as filler"),
                _option("ignore", "Ignore"),
            ],
        ),
        ModeParameter(
            key="allow_water_crossings",
            label="Allow untagged water crossings",
            kind="boolean",
            group="map",
            default=False,
        ),
        ModeParameter(
            key="theme",
            label="Glyph theme",
            kind="enum",
            group="composition",
            default="city",
            options=[
                _option("city", "Circuit metropolis"),
                _option("fairground", "Fairground atlas"),
                _option("industrial", "Industrial borough"),
            ],
        ),
        ModeParameter(
            key="building_replacement_probability",
            label="Building replacement",
            kind="number",
            group="composition",
            default=0.75,
            minimum=0,
            maximum=1,
            step=0.05,
        ),
        ModeParameter(
            key="poi_landmark_limit",
            label="POI landmarks",
            kind="integer",
            group="composition",
            default=4,
            minimum=0,
            maximum=20,
            step=1,
        ),
        ModeParameter(
            key="landmark_size_mm",
            label="Landmark size",
            kind="number",
            group="composition",
            default=22,
            minimum=10,
            maximum=45,
            step=1,
            unit="mm",
        ),
        ModeParameter(
            key="road_attachment_distance_mm",
            label="Road attachment reach",
            kind="number",
            group="composition",
            default=18,
            minimum=1,
            maximum=60,
            step=1,
            unit="mm",
        ),
        ModeParameter(
            key="detail_level",
            label="Glyph detail",
            kind="integer",
            group="composition",
            default=3,
            minimum=1,
            maximum=5,
            step=1,
        ),
        ModeParameter(
            key="connector_density",
            label="Secondary connector density",
            kind="number",
            group="network",
            default=0.45,
            minimum=0,
            maximum=1,
            step=0.05,
        ),
        ModeParameter(
            key="loopiness",
            label="Secondary loopiness",
            kind="number",
            group="network",
            default=0.2,
            minimum=0,
            maximum=1,
            step=0.05,
        ),
        ModeParameter(
            key="routing_style",
            label="Secondary routing",
            kind="enum",
            group="network",
            default="eight-direction",
            options=[
                _option("orthogonal", "Orthogonal"),
                _option("eight-direction", "Eight direction"),
            ],
        ),
        ModeParameter(
            key="connector_style",
            label="Secondary decoration",
            kind="enum",
            group="network",
            default="mixed",
            options=[
                _option("mixed", "Port-preferred mix"),
                _option("single", "Single"),
                _option("double", "Double"),
                _option("wave", "Wave"),
                _option("zigzag", "Zigzag"),
                _option("ladder", "Ladder"),
                _option("beads", "Beads"),
                _option("bundle", "Bundle"),
            ],
        ),
        ModeParameter(
            key="route_corridor_mm",
            label="Route corridor",
            kind="number",
            group="network",
            default=4,
            minimum=1,
            maximum=12,
            step=0.5,
            unit="mm",
        ),
        ModeParameter(
            key="minimum_feature_mm",
            label="Minimum feature",
            kind="number",
            group="network",
            default=0.8,
            minimum=0.3,
            maximum=3,
            step=0.1,
            unit="mm",
        ),
        ModeParameter(
            key="minimum_gap_mm",
            label="Minimum gap",
            kind="number",
            group="network",
            default=1.2,
            minimum=0.4,
            maximum=8,
            step=0.2,
            unit="mm",
        ),
        ModeParameter(
            key="path_budget",
            label="Path budget",
            kind="integer",
            group="limits",
            default=5000,
            minimum=50,
            maximum=50000,
            step=100,
        ),
        ModeParameter(
            key="vertex_budget",
            label="Vertex budget",
            kind="integer",
            group="limits",
            default=250000,
            minimum=1000,
            maximum=2000000,
            step=1000,
        ),
    ]
    common: dict[str, str | int | float | bool | list[float]] = {
        "geographic_fidelity": 80,
        "water_behavior": "exclude",
        "park_behavior": "fill",
        "allow_water_crossings": False,
        "building_replacement_probability": 0.75,
        "poi_landmark_limit": 4,
        "landmark_size_mm": 22,
        "road_attachment_distance_mm": 18,
        "detail_level": 3,
        "connector_density": 0.45,
        "loopiness": 0.2,
        "routing_style": "eight-direction",
        "connector_style": "mixed",
        "route_corridor_mm": 4,
        "minimum_feature_mm": 0.8,
        "minimum_gap_mm": 1.2,
        "path_budget": 5000,
        "vertex_budget": 250000,
    }
    presets = [
        ModePreset(
            preset_id="circuit-metropolis",
            version=1,
            mode_id=HYBRID_MODE_ID,
            mode_version=HYBRID_MODE_VERSION,
            name="Circuit Metropolis",
            description="Major roads become bundled trunks among architectural city glyphs.",
            parameter_schema_version=1,
            seed="hybrid-circuit-1",
            parameters={**common, "theme": "city", "geographic_fidelity": 75},
        ),
        ModePreset(
            preset_id="fairground-atlas",
            version=1,
            mode_id=HYBRID_MODE_ID,
            mode_version=HYBRID_MODE_VERSION,
            name="Fairground Atlas",
            description="Map cells become playful fairground landmarks with flowing connections.",
            parameter_schema_version=1,
            seed="hybrid-fairground-1",
            parameters={
                **common,
                "theme": "fairground",
                "geographic_fidelity": 55,
                "connector_style": "wave",
                "building_replacement_probability": 0.65,
            },
        ),
        ModePreset(
            preset_id="industrial-borough",
            version=1,
            mode_id=HYBRID_MODE_ID,
            mode_version=HYBRID_MODE_VERSION,
            name="Industrial Borough",
            description="Factories and machinery retain a high-fidelity borough road skeleton.",
            parameter_schema_version=1,
            seed="hybrid-industrial-1",
            parameters={
                **common,
                "theme": "industrial",
                "geographic_fidelity": 90,
                "connector_style": "ladder",
                "park_behavior": "exclude",
            },
        ),
    ]
    return ModeManifest(
        id=HYBRID_MODE_ID,
        version=HYBRID_MODE_VERSION,
        name="Map-to-Glyphscape",
        description="Frozen OSM topology becomes locked trunks for a deterministic Glyphscape.",
        category="hybrid",
        quality_levels=list(QualityLevel),
        semantic_roles=[
            "hybrid-locked-road",
            "hybrid-road-decoration",
            "glyph-structure",
            "glyph-detail",
            "glyph-accent",
            "hybrid-road-attachment",
            "hybrid-secondary-connector",
            "hybrid-junction",
            "hybrid-landscape",
        ],
        parameter_schema_version=1,
        parameter_groups=groups,
        parameters=parameters,
        presets=presets,
        quality_mappings={
            QualityLevel.DRAFT: QualityMapping(
                density_scale=0.6,
                sampling_scale=0.7,
                label="Fast hybrid topology",
            ),
            QualityLevel.STANDARD: QualityMapping(
                density_scale=0.82,
                sampling_scale=0.88,
                label="Balanced map composition",
            ),
            QualityLevel.EXPORT: QualityMapping(
                density_scale=1,
                sampling_scale=1,
                label="Full map-derived detail",
            ),
        },
        default_complexity=ComplexityEstimate(paths=1200, vertices=30000, relative_work=5),
        algorithms=[
            "locked OSM topology",
            "deterministic building replacement",
            "POI landmark placement",
            "landscape masks",
            "geographic fidelity transform",
            "port-to-road attachment",
            "secondary occupancy routing",
            "road-class connector decoration",
        ],
    )


def estimate_map_glyphscape(context: GenerationContext) -> ComplexityEstimate:
    replacement = float(cast(int | float, context.parameters["building_replacement_probability"]))
    quality = {
        QualityLevel.DRAFT: 0.6,
        QualityLevel.STANDARD: 0.82,
        QualityLevel.EXPORT: 1.0,
    }[context.quality]
    return ComplexityEstimate(
        paths=min(
            cast(int, context.parameters["path_budget"]),
            round(1200 * quality * replacement),
        ),
        vertices=min(
            cast(int, context.parameters["vertex_budget"]),
            round(30000 * quality * replacement),
        ),
        relative_work=round(5 * quality * max(0.25, replacement), 3),
    )


def _snapshot_required(_: GenerationContext) -> DesignDocument:
    raise ValueError("Map-to-Glyphscape generation requires a frozen OSM snapshot")


def map_glyphscape_plugin() -> BuiltinModePlugin:
    return BuiltinModePlugin(
        manifest=map_glyphscape_manifest(),
        generator=_snapshot_required,
        parameter_migrations={},
        complexity_estimator=estimate_map_glyphscape,
    )


def generate_map_glyphscape_for_recipe(
    snapshot: Mapping[str, Any],
    recipe: ProjectRecipe,
    *,
    progress: ProgressCallback | None = None,
    cancellation: CancellationSignal | None = None,
) -> DesignDocument:
    plugin = map_glyphscape_plugin()
    settings = plugin.prepare_settings(recipe.mode)
    prepared = recipe.model_copy(update={"mode": settings})
    context = GenerationContext(
        recipe=prepared,
        quality=QualityLevel(settings.quality),
        parameters=settings.parameters,
        progress=progress,
        cancellation=cancellation,
    )
    estimate = estimate_map_glyphscape(context)
    path_budget = cast(int, settings.parameters["path_budget"])
    vertex_budget = cast(int, settings.parameters["vertex_budget"])
    if estimate.paths > path_budget or estimate.vertices > vertex_budget:
        raise ValueError("estimated hybrid complexity exceeds the configured budget")
    document = generate_map_glyphscape(snapshot, context)
    path_count = sum(len(layer.paths) for layer in document.layers)
    vertex_count = sum(len(path.commands) for layer in document.layers for path in layer.paths)
    if path_count > path_budget or vertex_count > vertex_budget:
        raise ValueError("generated hybrid complexity exceeds the configured budget")
    return document
