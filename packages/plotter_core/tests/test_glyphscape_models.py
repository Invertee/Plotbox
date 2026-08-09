from __future__ import annotations

import math
from collections.abc import Mapping

import pytest
from plotter_core.glyphscape import (
    BuiltinGlyphFamily,
    Glyph,
    GlyphAnchor,
    GlyphBounds,
    GlyphClearance,
    GlyphFamily,
    GlyphFamilyManifest,
    GlyphFamilyParameter,
    GlyphFamilyRegistry,
    GlyphGenerationContext,
    GlyphObstacle,
    GlyphParameterValue,
    GlyphPolygon,
    GlyphPort,
    GlyphRolePaths,
    GlyphScaleRange,
    UnitVector,
    glyph_metadata,
)
from plotter_core.models import DesignPath, LineCommand, MoveCommand, Point
from plotter_core.modes import QualityLevel
from pydantic import ValidationError


def rectangle(min_x: float, min_y: float, max_x: float, max_y: float) -> GlyphPolygon:
    return GlyphPolygon(
        vertices=[
            Point(x=min_x, y=min_y),
            Point(x=max_x, y=min_y),
            Point(x=max_x, y=max_y),
            Point(x=min_x, y=max_y),
        ]
    )


def line_path(path_id: str, start: Point, end: Point) -> DesignPath:
    return DesignPath(
        path_id=path_id,
        commands=[MoveCommand(point=start), LineCommand(point=end)],
    )


def manifest() -> GlyphFamilyManifest:
    return GlyphFamilyManifest(
        family_id="test-building",
        version="1.0.0",
        name="Test building",
        themes=["city"],
        tags=["building"],
        semantic_roles=["structure", "detail"],
        connection_types=["signal"],
        parameters=[
            GlyphFamilyParameter(
                key="floors",
                label="Floors",
                kind="integer",
                default=3,
                minimum=1,
                maximum=12,
            ),
            GlyphFamilyParameter(
                key="roof",
                label="Roof",
                kind="enum",
                default="flat",
                options=[
                    {"value": "flat", "label": "Flat"},
                    {"value": "peaked", "label": "Peaked"},
                ],
            ),
        ],
        minimum_size_mm=4,
        maximum_size_mm=80,
        maximum_complexity_score=100,
    )


def glyph(
    *,
    glyph_id: str = "building-1",
    family: GlyphFamilyManifest | None = None,
    path_end: Point | None = None,
) -> Glyph:
    family = family or manifest()
    return Glyph(
        glyph_id=glyph_id,
        family_id=family.family_id,
        family_version=family.version,
        local_bounds=GlyphBounds(min_x_mm=-5, min_y_mm=-5, max_x_mm=5, max_y_mm=5),
        role_paths=[
            GlyphRolePaths(
                semantic_role="structure",
                paths=[
                    line_path(
                        "body-line",
                        Point(x=-2, y=-2),
                        path_end or Point(x=2, y=2),
                    )
                ],
            )
        ],
        obstacle=GlyphObstacle(polygon=rectangle(-2.5, -2.5, 2.5, 2.5)),
        clearance=GlyphClearance(
            polygon=rectangle(-3, -3, 3, 3),
            minimum_gap_mm=0.5,
        ),
        ports=[
            GlyphPort(
                port_id="east",
                position=Point(x=3, y=0),
                outward_direction=UnitVector(x=1, y=0),
                connection_type="signal",
            )
        ],
        anchors=[GlyphAnchor(anchor_id="center", position=Point(x=0, y=0))],
        complexity_score=4,
        tags=["building"],
        allowed_scale_range=family.allowed_scale_range,
        allowed_rotation_range=family.allowed_rotation_range,
    )


def test_glyph_round_trip_preserves_versioned_contract() -> None:
    value = glyph()
    restored = Glyph.model_validate_json(value.model_dump_json())
    assert restored == value
    assert restored.schema_version == 1
    assert restored.clearance.polygon.area_mm2 == 36
    assert restored.clearance.polygon.contains(Point(x=3, y=0))


def test_polygon_rejects_degenerate_closed_and_self_intersecting_vertices() -> None:
    with pytest.raises(ValidationError, match="closure is implicit"):
        GlyphPolygon(
            vertices=[
                Point(x=0, y=0),
                Point(x=1, y=0),
                Point(x=1, y=1),
                Point(x=0, y=0),
            ]
        )
    with pytest.raises(ValidationError, match="non-zero area"):
        GlyphPolygon(vertices=[Point(x=0, y=0), Point(x=1, y=0), Point(x=2, y=0)])
    with pytest.raises(ValidationError, match="self-intersect"):
        GlyphPolygon(
            vertices=[
                Point(x=0, y=0),
                Point(x=2, y=2),
                Point(x=0, y=2),
                Point(x=2, y=0),
            ]
        )


def test_unit_vectors_and_physical_ranges_must_be_finite_and_valid() -> None:
    with pytest.raises(ValidationError, match="normalized"):
        UnitVector(x=2, y=0)
    with pytest.raises(ValidationError, match="finite"):
        GlyphBounds(min_x_mm=0, min_y_mm=0, max_x_mm=math.inf, max_y_mm=1)
    with pytest.raises(ValidationError, match="ordered"):
        GlyphScaleRange(minimum=2, maximum=1)


def test_glyph_rejects_geometry_outside_clearance_and_duplicate_ids() -> None:
    with pytest.raises(ValidationError, match="drawable geometry"):
        glyph(path_end=Point(x=4, y=2))

    payload = glyph().model_dump(mode="python")
    payload["ports"].append(payload["ports"][0])
    with pytest.raises(ValidationError, match="port IDs must be unique"):
        Glyph.model_validate(payload)


def test_glyph_rejects_obstacle_outside_clearance_and_unknown_fields() -> None:
    payload = glyph().model_dump(mode="python")
    payload["obstacle"] = GlyphObstacle(polygon=rectangle(-4, -4, 4, 4))
    with pytest.raises(ValidationError, match="contain the obstacle"):
        Glyph.model_validate(payload)

    payload = glyph().model_dump(mode="python")
    payload["network_address"] = "192.0.2.1"
    with pytest.raises(ValidationError, match="network_address"):
        Glyph.model_validate(payload)


def family_generator(context: GlyphGenerationContext) -> Glyph:
    family = manifest()
    floors = context.parameters["floors"]
    assert isinstance(floors, int)
    jitter = context.random.scalar("facade").uniform(-0.2, 0.2)
    value = glyph(glyph_id=context.glyph_id, family=family)
    return value.model_copy(
        update={
            "complexity_score": float(floors),
            "metadata": glyph_metadata(context, facade_jitter=round(jitter, 8)),
        }
    )


def test_family_defaults_parameters_and_uses_stable_named_random_streams() -> None:
    family = BuiltinGlyphFamily(manifest(), family_generator)
    assert isinstance(family, GlyphFamily)
    first = family.generate(
        "building-1",
        seed="fixed",
        width_mm=10,
        height_mm=10,
        quality=QualityLevel.STANDARD,
    )
    second = family.generate(
        "building-1",
        seed="fixed",
        width_mm=10,
        height_mm=10,
        quality=QualityLevel.STANDARD,
    )
    different = family.generate(
        "building-1",
        seed="different",
        width_mm=10,
        height_mm=10,
        quality=QualityLevel.STANDARD,
    )
    assert first == second
    assert first.metadata["facade_jitter"] != different.metadata["facade_jitter"]
    assert first.metadata["quality"] == "standard"


def test_family_rejects_unknown_invalid_and_oversized_parameters() -> None:
    family = BuiltinGlyphFamily(manifest(), family_generator)
    with pytest.raises(ValueError, match="unknown parameters"):
        family.prepare_parameters({"unknown": 1})
    with pytest.raises(ValueError, match="at most 12"):
        family.prepare_parameters({"floors": 13})
    with pytest.raises(ValueError, match=r"between 4\.0 and 80\.0"):
        family.generate(
            "building-1",
            seed="fixed",
            width_mm=100,
            height_mm=10,
            quality=QualityLevel.DRAFT,
        )


def test_family_output_is_checked_against_manifest() -> None:
    family_manifest = manifest()

    def invalid_generator(context: GlyphGenerationContext) -> Glyph:
        value = glyph(glyph_id=context.glyph_id, family=family_manifest)
        return value.model_copy(update={"family_version": "2.0.0"})

    family = BuiltinGlyphFamily(family_manifest, invalid_generator)
    with pytest.raises(ValueError, match="incompatible family identity"):
        family.generate(
            "building-1",
            seed="fixed",
            width_mm=10,
            height_mm=10,
            quality=QualityLevel.DRAFT,
        )


def test_family_registry_is_sorted_and_rejects_duplicates() -> None:
    registry = GlyphFamilyRegistry()
    family = BuiltinGlyphFamily(manifest(), family_generator)
    registry.register(family)
    assert registry.get("test-building") is family
    assert registry.manifests() == [family.manifest]
    with pytest.raises(ValueError, match="already registered"):
        registry.register(family)
    with pytest.raises(ValueError, match="unsupported glyph family"):
        registry.get("missing")


def test_generation_context_honors_cancellation_checkpoints() -> None:
    class CancelAfterOne:
        def __init__(self) -> None:
            self.calls = 0

        @property
        def cancelled(self) -> bool:
            return self.calls > 0

        def checkpoint(self) -> None:
            self.calls += 1
            if self.calls > 1:
                raise RuntimeError("cancelled")

    cancellation = CancelAfterOne()
    family = BuiltinGlyphFamily(manifest(), family_generator)
    with pytest.raises(RuntimeError, match="cancelled"):
        family.generate(
            "building-1",
            seed="fixed",
            width_mm=10,
            height_mm=10,
            quality=QualityLevel.DRAFT,
            cancellation=cancellation,
        )
    assert cancellation.calls == 2


def test_family_parameters_accept_read_only_mappings() -> None:
    family = BuiltinGlyphFamily(manifest(), family_generator)
    parameters: Mapping[str, GlyphParameterValue] = {"floors": 4, "roof": "peaked"}
    assert family.prepare_parameters(parameters) == {"floors": 4, "roof": "peaked"}
