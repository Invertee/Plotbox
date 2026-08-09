from __future__ import annotations

import math
import re
from typing import Literal

from pydantic import Field, model_validator

from plotter_core.models import (
    CubicCommand,
    DesignPath,
    LineCommand,
    MoveCommand,
    Point,
    QuadraticCommand,
    StrictModel,
)

GLYPH_SCHEMA_VERSION: Literal[1] = 1
type GlyphParameterValue = str | int | float | bool
type GlyphMetadataValue = str | int | float | bool

_ID_PATTERN = r"^[a-z][a-z0-9-]*$"
_ROLE_PATTERN = r"^[a-z][a-z0-9-]*$"
_GEOMETRY_TOLERANCE = 1e-9


def _cross(first: Point, second: Point, third: Point) -> float:
    return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x)


def _point_on_segment(point: Point, start: Point, end: Point) -> bool:
    if abs(_cross(start, end, point)) > _GEOMETRY_TOLERANCE:
        return False
    return (
        min(start.x, end.x) - _GEOMETRY_TOLERANCE
        <= point.x
        <= max(start.x, end.x) + _GEOMETRY_TOLERANCE
        and min(start.y, end.y) - _GEOMETRY_TOLERANCE
        <= point.y
        <= max(start.y, end.y) + _GEOMETRY_TOLERANCE
    )


def _segments_intersect(first: Point, second: Point, third: Point, fourth: Point) -> bool:
    orientations = (
        _cross(first, second, third),
        _cross(first, second, fourth),
        _cross(third, fourth, first),
        _cross(third, fourth, second),
    )
    if (
        orientations[0] * orientations[1] < -_GEOMETRY_TOLERANCE
        and orientations[2] * orientations[3] < -_GEOMETRY_TOLERANCE
    ):
        return True
    return (
        (abs(orientations[0]) <= _GEOMETRY_TOLERANCE and _point_on_segment(third, first, second))
        or (
            abs(orientations[1]) <= _GEOMETRY_TOLERANCE and _point_on_segment(fourth, first, second)
        )
        or (abs(orientations[2]) <= _GEOMETRY_TOLERANCE and _point_on_segment(first, third, fourth))
        or (
            abs(orientations[3]) <= _GEOMETRY_TOLERANCE and _point_on_segment(second, third, fourth)
        )
    )


class GlyphPolygon(StrictModel):
    """An implicitly closed simple polygon in local glyph millimetres."""

    vertices: list[Point] = Field(min_length=3)

    @model_validator(mode="after")
    def is_simple_and_non_degenerate(self) -> GlyphPolygon:
        coordinates = [(point.x, point.y) for point in self.vertices]
        if len(coordinates) != len(set(coordinates)):
            raise ValueError("glyph polygon vertices must be distinct; closure is implicit")
        edges = list(
            zip(
                self.vertices,
                [*self.vertices[1:], self.vertices[0]],
                strict=True,
            )
        )
        for first_index, (first, second) in enumerate(edges):
            for second_index, (third, fourth) in enumerate(
                edges[first_index + 1 :],
                first_index + 1,
            ):
                adjacent = second_index == first_index + 1 or (
                    first_index == 0 and second_index == len(edges) - 1
                )
                if not adjacent and _segments_intersect(first, second, third, fourth):
                    raise ValueError("glyph polygon must not self-intersect")
        signed_area_twice = sum(first.x * second.y - second.x * first.y for first, second in edges)
        if abs(signed_area_twice) <= _GEOMETRY_TOLERANCE:
            raise ValueError("glyph polygon must enclose a non-zero area")
        return self

    @property
    def area_mm2(self) -> float:
        return (
            abs(
                sum(
                    first.x * second.y - second.x * first.y
                    for first, second in zip(
                        self.vertices,
                        [*self.vertices[1:], self.vertices[0]],
                        strict=True,
                    )
                )
            )
            / 2
        )

    def contains(self, point: Point) -> bool:
        """Return true for points inside the polygon or on its boundary."""
        crossings = False
        previous = self.vertices[-1]
        for current in self.vertices:
            if _point_on_segment(point, previous, current):
                return True
            if (current.y > point.y) != (previous.y > point.y):
                intersection_x = (previous.x - current.x) * (point.y - current.y) / (
                    previous.y - current.y
                ) + current.x
                if point.x < intersection_x:
                    crossings = not crossings
            previous = current
        return crossings


class GlyphBounds(StrictModel):
    min_x_mm: float
    min_y_mm: float
    max_x_mm: float
    max_y_mm: float

    @model_validator(mode="after")
    def is_finite_and_non_empty(self) -> GlyphBounds:
        values = (self.min_x_mm, self.min_y_mm, self.max_x_mm, self.max_y_mm)
        if not all(math.isfinite(value) for value in values):
            raise ValueError("glyph bounds must be finite")
        if self.min_x_mm >= self.max_x_mm or self.min_y_mm >= self.max_y_mm:
            raise ValueError("glyph bounds must have positive width and height")
        return self

    @property
    def width_mm(self) -> float:
        return self.max_x_mm - self.min_x_mm

    @property
    def height_mm(self) -> float:
        return self.max_y_mm - self.min_y_mm

    def contains(self, point: Point) -> bool:
        return (
            self.min_x_mm - _GEOMETRY_TOLERANCE <= point.x <= self.max_x_mm + _GEOMETRY_TOLERANCE
            and self.min_y_mm - _GEOMETRY_TOLERANCE
            <= point.y
            <= self.max_y_mm + _GEOMETRY_TOLERANCE
        )


class UnitVector(StrictModel):
    x: float
    y: float

    @model_validator(mode="after")
    def is_finite_and_normalized(self) -> UnitVector:
        if not math.isfinite(self.x) or not math.isfinite(self.y):
            raise ValueError("port direction must be finite")
        magnitude = math.hypot(self.x, self.y)
        if not math.isclose(magnitude, 1.0, rel_tol=0, abs_tol=1e-6):
            raise ValueError("port direction must be normalized")
        return self


class GlyphPort(StrictModel):
    port_id: str = Field(pattern=_ID_PATTERN)
    position: Point
    outward_direction: UnitVector
    connection_type: str = Field(pattern=_ID_PATTERN)
    capacity: int = Field(default=1, ge=1, le=32)
    preferred_connector_family: str = Field(default="single", pattern=_ID_PATTERN)
    preferred_semantic_role: str = Field(default="connector", pattern=_ROLE_PATTERN)
    clearance_mm: float = Field(default=0.5, ge=0, le=100)

    @model_validator(mode="after")
    def values_are_finite(self) -> GlyphPort:
        if not math.isfinite(self.clearance_mm):
            raise ValueError("port clearance must be finite")
        return self


class GlyphAnchor(StrictModel):
    anchor_id: str = Field(pattern=_ID_PATTERN)
    position: Point
    kind: Literal["placement", "balance", "decoration", "baseline"] = "placement"


class GlyphObstacle(StrictModel):
    obstacle_id: str = Field(default="body", pattern=_ID_PATTERN)
    polygon: GlyphPolygon
    blocks_routing: bool = True


class GlyphClearance(StrictModel):
    polygon: GlyphPolygon
    minimum_gap_mm: float = Field(default=0.5, ge=0, le=100)

    @model_validator(mode="after")
    def gap_is_finite(self) -> GlyphClearance:
        if not math.isfinite(self.minimum_gap_mm):
            raise ValueError("glyph minimum gap must be finite")
        return self


class GlyphRolePaths(StrictModel):
    semantic_role: str = Field(pattern=_ROLE_PATTERN)
    paths: list[DesignPath] = Field(min_length=1)

    @model_validator(mode="after")
    def path_ids_are_unique(self) -> GlyphRolePaths:
        path_ids = [path.path_id for path in self.paths]
        if len(path_ids) != len(set(path_ids)):
            raise ValueError(f"glyph role {self.semantic_role} contains duplicate path IDs")
        return self


class GlyphScaleRange(StrictModel):
    minimum: float = Field(default=0.5, gt=0, le=100)
    maximum: float = Field(default=2.0, gt=0, le=100)

    @model_validator(mode="after")
    def is_finite_and_ordered(self) -> GlyphScaleRange:
        if not math.isfinite(self.minimum) or not math.isfinite(self.maximum):
            raise ValueError("glyph scale range must be finite")
        if self.minimum > self.maximum:
            raise ValueError("glyph scale range must be ordered")
        return self


class GlyphRotationRange(StrictModel):
    minimum_radians: float = -math.pi
    maximum_radians: float = math.pi

    @model_validator(mode="after")
    def is_finite_and_ordered(self) -> GlyphRotationRange:
        if not math.isfinite(self.minimum_radians) or not math.isfinite(self.maximum_radians):
            raise ValueError("glyph rotation range must be finite")
        if self.minimum_radians > self.maximum_radians:
            raise ValueError("glyph rotation range must be ordered")
        if self.maximum_radians - self.minimum_radians > math.tau + _GEOMETRY_TOLERANCE:
            raise ValueError("glyph rotation range cannot exceed one full turn")
        return self


def _path_control_points(path: DesignPath) -> list[Point]:
    points: list[Point] = []
    for command in path.commands:
        if isinstance(command, MoveCommand | LineCommand):
            points.append(command.point)
        elif isinstance(command, QuadraticCommand):
            points.extend((command.control, command.point))
        elif isinstance(command, CubicCommand):
            points.extend((command.control1, command.control2, command.point))
    return points


class Glyph(StrictModel):
    """Reusable local-coordinate glyph geometry produced by a glyph family."""

    schema_version: Literal[1] = GLYPH_SCHEMA_VERSION
    glyph_id: str = Field(pattern=_ID_PATTERN)
    family_id: str = Field(pattern=_ID_PATTERN)
    family_version: str = Field(min_length=1)
    local_bounds: GlyphBounds
    role_paths: list[GlyphRolePaths] = Field(min_length=1)
    obstacle: GlyphObstacle
    clearance: GlyphClearance
    ports: list[GlyphPort] = Field(default_factory=list)
    anchors: list[GlyphAnchor] = Field(min_length=1)
    complexity_score: float = Field(ge=0)
    tags: list[str] = Field(min_length=1)
    allowed_scale_range: GlyphScaleRange = Field(default_factory=GlyphScaleRange)
    allowed_rotation_range: GlyphRotationRange = Field(default_factory=GlyphRotationRange)
    metadata: dict[str, GlyphMetadataValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def geometry_and_ids_are_consistent(self) -> Glyph:
        if not math.isfinite(self.complexity_score):
            raise ValueError("glyph complexity score must be finite")
        role_names = [group.semantic_role for group in self.role_paths]
        if len(role_names) != len(set(role_names)):
            raise ValueError("glyph semantic roles must be unique")
        path_ids = [path.path_id for group in self.role_paths for path in group.paths]
        if len(path_ids) != len(set(path_ids)):
            raise ValueError("glyph path IDs must be unique across semantic roles")
        port_ids = [port.port_id for port in self.ports]
        if len(port_ids) != len(set(port_ids)):
            raise ValueError("glyph port IDs must be unique")
        anchor_ids = [anchor.anchor_id for anchor in self.anchors]
        if len(anchor_ids) != len(set(anchor_ids)):
            raise ValueError("glyph anchor IDs must be unique")
        if len(self.tags) != len(set(self.tags)):
            raise ValueError("glyph tags must be unique")

        clearance = self.clearance.polygon
        if any(not self.local_bounds.contains(point) for point in clearance.vertices):
            raise ValueError("glyph clearance must remain inside local bounds")
        if any(not clearance.contains(point) for point in self.obstacle.polygon.vertices):
            raise ValueError("glyph clearance must contain the obstacle")
        if any(not clearance.contains(port.position) for port in self.ports):
            raise ValueError("glyph ports must remain inside the clearance polygon")
        if any(not self.local_bounds.contains(anchor.position) for anchor in self.anchors):
            raise ValueError("glyph anchors must remain inside local bounds")
        drawable_points = [
            point
            for group in self.role_paths
            for path in group.paths
            for point in _path_control_points(path)
        ]
        if any(not clearance.contains(point) for point in drawable_points):
            raise ValueError("glyph drawable geometry must remain inside the clearance polygon")
        return self


class GlyphParameterOption(StrictModel):
    value: str = Field(min_length=1)
    label: str = Field(min_length=1)


class GlyphFamilyParameter(StrictModel):
    key: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    label: str = Field(min_length=1)
    kind: Literal["number", "integer", "boolean", "enum"]
    default: GlyphParameterValue
    description: str = ""
    unit: str = ""
    minimum: float | None = None
    maximum: float | None = None
    step: float | None = Field(default=None, gt=0)
    options: list[GlyphParameterOption] = Field(default_factory=list)

    @model_validator(mode="after")
    def definition_is_consistent(self) -> GlyphFamilyParameter:
        for bound in (self.minimum, self.maximum, self.step):
            if bound is not None and not math.isfinite(bound):
                raise ValueError(f"{self.key}: numeric constraints must be finite")
        if self.minimum is not None and self.maximum is not None and self.minimum > self.maximum:
            raise ValueError(f"{self.key}: minimum must not exceed maximum")
        if self.kind == "enum":
            option_values = [option.value for option in self.options]
            if not option_values or len(option_values) != len(set(option_values)):
                raise ValueError(f"{self.key}: enum options must be present and unique")
        elif self.options:
            raise ValueError(f"{self.key}: options are only valid for enum parameters")
        self.validate_value(self.default)
        return self

    def validate_value(self, value: GlyphParameterValue) -> None:
        numeric: float | None = None
        if self.kind == "integer":
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"{self.key} must be an integer")
            numeric = float(value)
        elif self.kind == "number":
            if isinstance(value, bool) or not isinstance(value, int | float):
                raise ValueError(f"{self.key} must be numeric")
            numeric = float(value)
        elif self.kind == "boolean":
            if not isinstance(value, bool):
                raise ValueError(f"{self.key} must be a boolean")
        elif not isinstance(value, str) or value not in {option.value for option in self.options}:
            raise ValueError(f"{self.key} must be one of the declared options")
        if numeric is not None:
            if not math.isfinite(numeric):
                raise ValueError(f"{self.key} must be finite")
            if self.minimum is not None and numeric < self.minimum:
                raise ValueError(f"{self.key} must be at least {self.minimum}")
            if self.maximum is not None and numeric > self.maximum:
                raise ValueError(f"{self.key} must be at most {self.maximum}")


class GlyphFamilyManifest(StrictModel):
    schema_version: Literal[1] = GLYPH_SCHEMA_VERSION
    family_id: str = Field(pattern=_ID_PATTERN)
    version: str = Field(pattern=r"^[0-9]+\.[0-9]+\.[0-9]+$")
    name: str = Field(min_length=1)
    description: str = ""
    themes: list[str] = Field(min_length=1)
    tags: list[str] = Field(min_length=1)
    semantic_roles: list[str] = Field(min_length=1)
    connection_types: list[str] = Field(default_factory=list)
    parameters: list[GlyphFamilyParameter] = Field(default_factory=list)
    minimum_size_mm: float = Field(default=4, gt=0, le=1000)
    maximum_size_mm: float = Field(default=100, gt=0, le=2000)
    allowed_scale_range: GlyphScaleRange = Field(default_factory=GlyphScaleRange)
    allowed_rotation_range: GlyphRotationRange = Field(default_factory=GlyphRotationRange)
    maximum_complexity_score: float = Field(default=10_000, ge=0)

    @model_validator(mode="after")
    def values_are_consistent(self) -> GlyphFamilyManifest:
        for value in (self.minimum_size_mm, self.maximum_size_mm, self.maximum_complexity_score):
            if not math.isfinite(value):
                raise ValueError("glyph family size and complexity limits must be finite")
        if self.minimum_size_mm > self.maximum_size_mm:
            raise ValueError("glyph family size range must be ordered")
        for label, values in (
            ("themes", self.themes),
            ("tags", self.tags),
            ("semantic roles", self.semantic_roles),
            ("connection types", self.connection_types),
        ):
            if len(values) != len(set(values)):
                raise ValueError(f"glyph family {label} must be unique")
        for role in self.semantic_roles:
            if re.fullmatch(_ROLE_PATTERN, role) is None:
                raise ValueError(f"invalid glyph family semantic role: {role}")
        for connection_type in self.connection_types:
            if re.fullmatch(_ID_PATTERN, connection_type) is None:
                raise ValueError(f"invalid glyph family connection type: {connection_type}")
        parameter_keys = [parameter.key for parameter in self.parameters]
        if len(parameter_keys) != len(set(parameter_keys)):
            raise ValueError("glyph family parameter keys must be unique")
        return self
