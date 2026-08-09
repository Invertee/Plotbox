from __future__ import annotations

import math

import pytest
from plotter_core.glyphscape import (
    MINIMUM_FEATURE_MM,
    Glyph,
    builtin_glyph_families,
    create_builtin_glyph_registry,
)
from plotter_core.models import CubicCommand, LineCommand, MoveCommand, Point, QuadraticCommand
from plotter_core.modes import QualityLevel

EXPECTED_FAMILIES = {
    "city-building",
    "city-bridge",
    "city-station",
    "city-tower",
    "fairground-big-top",
    "fairground-booth",
    "fairground-carousel",
    "fairground-ferris-wheel",
    "industrial-crane",
    "industrial-factory",
    "industrial-machine-panel",
    "industrial-silo",
    "industrial-turbine",
}


def _points(glyph: Glyph) -> list[Point]:
    points: list[Point] = []
    for group in glyph.role_paths:
        for path in group.paths:
            for command in path.commands:
                if isinstance(command, MoveCommand | LineCommand):
                    points.append(command.point)
                elif isinstance(command, QuadraticCommand):
                    points.extend((command.control, command.point))
                elif isinstance(command, CubicCommand):
                    points.extend((command.control1, command.control2, command.point))
    return points


def _path_count(glyph: Glyph) -> int:
    return sum(len(group.paths) for group in glyph.role_paths)


def test_builtin_registry_contains_the_complete_initial_theme_library() -> None:
    registry = create_builtin_glyph_registry()
    manifests = registry.manifests()
    assert {manifest.family_id for manifest in manifests} == EXPECTED_FAMILIES
    assert {manifest.themes[0] for manifest in manifests} == {
        "city",
        "industrial",
        "fairground",
    }
    assert all(manifest.parameters for manifest in manifests)
    assert all(manifest.minimum_size_mm >= 6 for manifest in manifests)


@pytest.mark.parametrize(
    "family", builtin_glyph_families(), ids=lambda family: family.manifest.family_id
)
def test_each_family_is_deterministic_finite_bounded_and_physically_annotated(
    family: object,
) -> None:
    assert hasattr(family, "generate")
    typed_family = family
    size = max(24.0, typed_family.manifest.minimum_size_mm)
    first = typed_family.generate(
        "fixture-glyph",
        seed="stable-seed",
        width_mm=size,
        height_mm=size,
        quality=QualityLevel.STANDARD,
    )
    second = typed_family.generate(
        "fixture-glyph",
        seed="stable-seed",
        width_mm=size,
        height_mm=size,
        quality=QualityLevel.STANDARD,
    )
    assert first == second
    assert first.metadata["minimum_feature_mm"] == MINIMUM_FEATURE_MM
    assert first.metadata["theme"] == family.manifest.themes[0]
    assert len(first.ports) == 4
    assert {port.port_id for port in first.ports} == {"north", "south", "east", "west"}
    assert all(first.clearance.polygon.contains(point) for point in _points(first))
    assert all(
        first.local_bounds.contains(point) and math.isfinite(point.x) and math.isfinite(point.y)
        for point in _points(first)
    )
    assert first.complexity_score >= _path_count(first)
    assert {group.semantic_role for group in first.role_paths}.issubset(
        set(family.manifest.semantic_roles)
    )


@pytest.mark.parametrize(
    "family", builtin_glyph_families(), ids=lambda family: family.manifest.family_id
)
def test_detail_parameter_and_quality_change_work_without_exceeding_bounds(family: object) -> None:
    size = max(28.0, family.manifest.minimum_size_mm)
    draft = family.generate(
        "parameter-glyph",
        seed="stable-seed",
        width_mm=size,
        height_mm=size,
        quality=QualityLevel.DRAFT,
        parameters={"detail_level": 5},
    )
    export = family.generate(
        "parameter-glyph",
        seed="stable-seed",
        width_mm=size,
        height_mm=size,
        quality=QualityLevel.EXPORT,
        parameters={"detail_level": 5},
    )
    ornate = family.generate(
        "parameter-glyph",
        seed="stable-seed",
        width_mm=size,
        height_mm=size,
        quality=QualityLevel.EXPORT,
        parameters={"detail_level": 5, "variant": "ornate"},
    )
    assert draft.metadata["detail_level"] <= 2
    assert export.metadata["detail_level"] == 5
    assert _path_count(export) >= _path_count(draft)
    assert ornate.metadata["variant"] == "ornate"
    assert all(ornate.clearance.polygon.contains(point) for point in _points(ornate))


def test_named_random_variation_is_stable_and_observable() -> None:
    registry = create_builtin_glyph_registry()
    for family_id in ("city-building", "industrial-crane", "fairground-ferris-wheel"):
        family = registry.get(family_id)
        first = family.generate(
            "seeded-glyph",
            seed="first",
            width_mm=30,
            height_mm=30,
            quality=QualityLevel.STANDARD,
        )
        second = family.generate(
            "seeded-glyph",
            seed="second",
            width_mm=30,
            height_mm=30,
            quality=QualityLevel.STANDARD,
        )
        assert first != second


def test_small_glyphs_reduce_detail_at_the_physical_cutoff() -> None:
    family = create_builtin_glyph_registry().get("city-building")
    glyph = family.generate(
        "small-building",
        seed="small",
        width_mm=family.manifest.minimum_size_mm,
        height_mm=family.manifest.minimum_size_mm,
        quality=QualityLevel.EXPORT,
        parameters={"detail_level": 5},
    )
    assert 1 <= glyph.metadata["detail_level"] <= 5
    assert glyph.clearance.minimum_gap_mm == MINIMUM_FEATURE_MM
