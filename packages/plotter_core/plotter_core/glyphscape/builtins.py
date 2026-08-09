from __future__ import annotations

import math
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from plotter_core.glyphscape.families import (
    BuiltinGlyphFamily,
    GlyphFamilyRegistry,
    GlyphGenerationContext,
    glyph_metadata,
)
from plotter_core.glyphscape.models import (
    Glyph,
    GlyphAnchor,
    GlyphBounds,
    GlyphClearance,
    GlyphFamilyManifest,
    GlyphFamilyParameter,
    GlyphObstacle,
    GlyphParameterOption,
    GlyphPolygon,
    GlyphPort,
    GlyphRolePaths,
    GlyphRotationRange,
    GlyphScaleRange,
    UnitVector,
)
from plotter_core.models import (
    CloseCommand,
    CubicCommand,
    DesignPath,
    LineCommand,
    MoveCommand,
    Point,
)
from plotter_core.modes import QualityLevel

FAMILY_VERSION = "1.0.0"
MINIMUM_FEATURE_MM = 0.8
_ROLE_STRUCTURE = "glyph-structure"
_ROLE_DETAIL = "glyph-detail"
_ROLE_ACCENT = "glyph-accent"
_COMMON_ROLES = [_ROLE_STRUCTURE, _ROLE_DETAIL, _ROLE_ACCENT]
_CONNECTION_TYPES = ["structural", "signal", "pedestrian"]
_SCALE_RANGE = GlyphScaleRange(minimum=0.75, maximum=2.5)
_ROTATION_RANGE = GlyphRotationRange(minimum_radians=-math.pi / 2, maximum_radians=math.pi / 2)


class _Canvas:
    def __init__(self, context: GlyphGenerationContext) -> None:
        self.context = context
        self.half_width = context.width_mm / 2
        self.half_height = context.height_mm / 2
        self.left = -self.half_width * 0.9
        self.right = self.half_width * 0.9
        self.bottom = -self.half_height * 0.9
        self.top = self.half_height * 0.9
        self.width = self.right - self.left
        self.height = self.top - self.bottom
        requested = context.parameters["detail_level"]
        if not isinstance(requested, int):
            raise TypeError("detail_level must be an integer")
        quality_limit = {
            QualityLevel.DRAFT: 2,
            QualityLevel.STANDARD: 4,
            QualityLevel.EXPORT: 5,
        }[context.quality]
        physical_limit = max(1, int(min(self.width, self.height) / MINIMUM_FEATURE_MM))
        self.detail_level = min(requested, quality_limit, physical_limit)
        variant = context.parameters["variant"]
        if not isinstance(variant, str):
            raise TypeError("variant must be a string")
        self.variant = variant

    def point(self, x: float, y: float) -> Point:
        return Point(x=x, y=y)

    def line(self, path_id: str, points: Iterable[tuple[float, float]]) -> DesignPath:
        values = list(points)
        return DesignPath(
            path_id=path_id,
            commands=[
                MoveCommand(point=self.point(*values[0])),
                *(LineCommand(point=self.point(*value)) for value in values[1:]),
            ],
        )

    def polygon(self, path_id: str, points: Iterable[tuple[float, float]]) -> DesignPath:
        values = list(points)
        return DesignPath(
            path_id=path_id,
            commands=[
                MoveCommand(point=self.point(*values[0])),
                *(LineCommand(point=self.point(*value)) for value in values[1:]),
                CloseCommand(),
            ],
            closed=True,
        )

    def ellipse(
        self,
        path_id: str,
        center_x: float,
        center_y: float,
        radius_x: float,
        radius_y: float,
    ) -> DesignPath:
        kappa = 0.5522847498
        return DesignPath(
            path_id=path_id,
            commands=[
                MoveCommand(point=self.point(center_x + radius_x, center_y)),
                CubicCommand(
                    control1=self.point(center_x + radius_x, center_y + kappa * radius_y),
                    control2=self.point(center_x + kappa * radius_x, center_y + radius_y),
                    point=self.point(center_x, center_y + radius_y),
                ),
                CubicCommand(
                    control1=self.point(center_x - kappa * radius_x, center_y + radius_y),
                    control2=self.point(center_x - radius_x, center_y + kappa * radius_y),
                    point=self.point(center_x - radius_x, center_y),
                ),
                CubicCommand(
                    control1=self.point(center_x - radius_x, center_y - kappa * radius_y),
                    control2=self.point(center_x - kappa * radius_x, center_y - radius_y),
                    point=self.point(center_x, center_y - radius_y),
                ),
                CubicCommand(
                    control1=self.point(center_x + kappa * radius_x, center_y - radius_y),
                    control2=self.point(center_x + radius_x, center_y - kappa * radius_y),
                    point=self.point(center_x + radius_x, center_y),
                ),
                CloseCommand(),
            ],
            closed=True,
        )


@dataclass(frozen=True)
class _FamilySpec:
    family_id: str
    name: str
    theme: str
    tags: tuple[str, ...]
    minimum_size_mm: float
    generator: Callable[[GlyphGenerationContext, _Canvas], dict[str, list[DesignPath]]]


def _rect(min_x: float, min_y: float, max_x: float, max_y: float) -> GlyphPolygon:
    return GlyphPolygon(
        vertices=[
            Point(x=min_x, y=min_y),
            Point(x=max_x, y=min_y),
            Point(x=max_x, y=max_y),
            Point(x=min_x, y=max_y),
        ]
    )


def _even_positions(start: float, end: float, count: int) -> list[float]:
    if count <= 0:
        return []
    step = (end - start) / (count + 1)
    return [start + step * (index + 1) for index in range(count)]


def _building(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    roof_y = canvas.top * (0.72 if canvas.variant == "classic" else 0.82)
    paths = {
        _ROLE_STRUCTURE: [
            canvas.polygon(
                "body",
                [
                    (canvas.left * 0.72, canvas.bottom),
                    (canvas.right * 0.72, canvas.bottom),
                    (canvas.right * 0.72, roof_y),
                    (canvas.left * 0.72, roof_y),
                ],
            )
        ],
        _ROLE_DETAIL: [],
        _ROLE_ACCENT: [],
    }
    floors = max(1, canvas.detail_level)
    random = context.random.scalar("facade")
    for index, y in enumerate(_even_positions(canvas.bottom, roof_y, floors)):
        inset = random.uniform(0.02, 0.08) * canvas.width
        paths[_ROLE_DETAIL].append(
            canvas.line(
                f"floor-{index}",
                [(canvas.left * 0.72 + inset, y), (canvas.right * 0.72 - inset, y)],
            )
        )
    if canvas.variant == "ornate":
        paths[_ROLE_ACCENT].append(
            canvas.line(
                "roof",
                [(canvas.left * 0.76, roof_y), (0, canvas.top), (canvas.right * 0.76, roof_y)],
            )
        )
    return paths


def _tower(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    waist = canvas.width * 0.12
    base = canvas.width * 0.32
    paths = {
        _ROLE_STRUCTURE: [
            canvas.line(
                "tower-frame",
                [
                    (-base, canvas.bottom),
                    (-waist, canvas.top * 0.68),
                    (0, canvas.top),
                    (waist, canvas.top * 0.68),
                    (base, canvas.bottom),
                ],
            )
        ],
        _ROLE_DETAIL: [],
        _ROLE_ACCENT: [canvas.line("base", [(-base, canvas.bottom), (base, canvas.bottom)])],
    }
    for index, y in enumerate(
        _even_positions(canvas.bottom, canvas.top * 0.62, canvas.detail_level + 1)
    ):
        ratio = (y - canvas.bottom) / (canvas.top * 0.68 - canvas.bottom)
        half = base + (waist - base) * ratio
        paths[_ROLE_DETAIL].append(canvas.line(f"brace-{index}", [(-half, y), (half, y)]))
    if canvas.variant == "ornate":
        paths[_ROLE_ACCENT].append(canvas.ellipse("beacon", 0, canvas.top * 0.74, waist, waist))
    return paths


def _station(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    canopy_y = canvas.top * 0.42
    paths = {
        _ROLE_STRUCTURE: [
            canvas.polygon(
                "hall",
                [
                    (canvas.left * 0.82, canvas.bottom),
                    (canvas.right * 0.82, canvas.bottom),
                    (canvas.right * 0.82, canopy_y),
                    (0, canvas.top),
                    (canvas.left * 0.82, canopy_y),
                ],
            )
        ],
        _ROLE_DETAIL: [
            canvas.line("platform", [(canvas.left, canvas.bottom), (canvas.right, canvas.bottom)]),
            canvas.ellipse(
                "clock",
                0,
                canopy_y * 0.98,
                min(canvas.width, canvas.height) * 0.09,
                min(canvas.width, canvas.height) * 0.09,
            ),
        ],
        _ROLE_ACCENT: [],
    }
    for index, x in enumerate(
        _even_positions(canvas.left * 0.7, canvas.right * 0.7, canvas.detail_level + 1)
    ):
        paths[_ROLE_DETAIL].append(
            canvas.line(f"door-{index}", [(x, canvas.bottom), (x, canopy_y * 0.72)])
        )
    return paths


def _bridge(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    deck_y = canvas.bottom * 0.35
    paths = {
        _ROLE_STRUCTURE: [
            canvas.line("deck", [(canvas.left, deck_y), (canvas.right, deck_y)]),
            canvas.line(
                "arch",
                [
                    (canvas.left, deck_y),
                    (canvas.left * 0.5, canvas.top * 0.55),
                    (0, canvas.top * 0.72),
                    (canvas.right * 0.5, canvas.top * 0.55),
                    (canvas.right, deck_y),
                ],
            ),
        ],
        _ROLE_DETAIL: [],
        _ROLE_ACCENT: [],
    }
    for index, x in enumerate(
        _even_positions(canvas.left * 0.85, canvas.right * 0.85, canvas.detail_level + 2)
    ):
        arch_y = deck_y + (canvas.top * 0.72 - deck_y) * (1 - (x / canvas.right) ** 2)
        paths[_ROLE_DETAIL].append(canvas.line(f"hanger-{index}", [(x, deck_y), (x, arch_y)]))
    return paths


def _factory(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    saw_count = max(2, canvas.detail_level + 1)
    roof = [(canvas.left, canvas.top * 0.2)]
    step = canvas.width / saw_count
    for index in range(saw_count):
        start = canvas.left + index * step
        roof.extend(
            [
                (start + step * 0.65, canvas.top * 0.62),
                (start + step, canvas.top * 0.2),
            ]
        )
    structure = canvas.line(
        "factory-shell",
        [(canvas.left, canvas.bottom), *roof, (canvas.right, canvas.bottom)],
    )
    paths = {
        _ROLE_STRUCTURE: [structure],
        _ROLE_DETAIL: [],
        _ROLE_ACCENT: [
            canvas.polygon(
                "chimney",
                [
                    (canvas.right * 0.48, canvas.top * 0.25),
                    (canvas.right * 0.74, canvas.top * 0.25),
                    (canvas.right * 0.7, canvas.top),
                    (canvas.right * 0.52, canvas.top),
                ],
            )
        ],
    }
    for index, x in enumerate(_even_positions(canvas.left, canvas.right, canvas.detail_level + 1)):
        paths[_ROLE_DETAIL].append(
            canvas.line(f"bay-{index}", [(x, canvas.bottom), (x, canvas.top * 0.12)])
        )
    return paths


def _silo(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    radius_x = canvas.width * 0.3
    radius_y = canvas.height * 0.1
    top_y = canvas.top * 0.55
    bottom_y = canvas.bottom * 0.72
    paths = {
        _ROLE_STRUCTURE: [
            canvas.ellipse("rim", 0, top_y, radius_x, radius_y),
            canvas.line("left-wall", [(-radius_x, top_y), (-radius_x, bottom_y)]),
            canvas.line("right-wall", [(radius_x, top_y), (radius_x, bottom_y)]),
            canvas.ellipse("base", 0, bottom_y, radius_x, radius_y),
        ],
        _ROLE_DETAIL: [],
        _ROLE_ACCENT: [
            canvas.line("cap", [(-radius_x, top_y), (0, canvas.top), (radius_x, top_y)])
        ],
    }
    for index, y in enumerate(_even_positions(bottom_y, top_y, canvas.detail_level)):
        paths[_ROLE_DETAIL].append(canvas.line(f"band-{index}", [(-radius_x, y), (radius_x, y)]))
    return paths


def _crane(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    mast_x = canvas.left * 0.45
    boom_y = canvas.top * 0.68
    trolley_x = context.random.scalar("trolley").uniform(-0.05, 0.55) * canvas.right
    paths = {
        _ROLE_STRUCTURE: [
            canvas.line("mast", [(mast_x, canvas.bottom), (mast_x, canvas.top)]),
            canvas.line("boom", [(canvas.left, boom_y), (canvas.right, boom_y)]),
            canvas.line("brace", [(mast_x, canvas.top), (canvas.right * 0.72, boom_y)]),
        ],
        _ROLE_DETAIL: [],
        _ROLE_ACCENT: [
            canvas.line("cable", [(trolley_x, boom_y), (trolley_x, canvas.bottom * 0.25)]),
            canvas.line(
                "hook",
                [
                    (trolley_x, canvas.bottom * 0.25),
                    (trolley_x + canvas.width * 0.04, canvas.bottom * 0.35),
                ],
            ),
        ],
    }
    for index, y in enumerate(
        _even_positions(canvas.bottom, canvas.top * 0.82, canvas.detail_level + 1)
    ):
        paths[_ROLE_DETAIL].append(
            canvas.line(
                f"mast-brace-{index}",
                [(mast_x - canvas.width * 0.07, y), (mast_x + canvas.width * 0.07, y)],
            )
        )
    return paths


def _turbine(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    center_y = canvas.top * 0.28
    radius = min(canvas.width, canvas.height) * 0.34
    blade_count = 3 if canvas.variant == "classic" else 5
    paths = {
        _ROLE_STRUCTURE: [
            canvas.line(
                "mast",
                [
                    (-canvas.width * 0.08, canvas.bottom),
                    (0, center_y),
                    (canvas.width * 0.08, canvas.bottom),
                ],
            ),
            canvas.ellipse("hub", 0, center_y, radius * 0.12, radius * 0.12),
        ],
        _ROLE_DETAIL: [],
        _ROLE_ACCENT: [],
    }
    phase = context.random.scalar("blades").uniform(-0.1, 0.1)
    for index in range(blade_count):
        angle = phase + math.tau * index / blade_count
        paths[_ROLE_ACCENT].append(
            canvas.line(
                f"blade-{index}",
                [
                    (0, center_y),
                    (math.cos(angle) * radius, center_y + math.sin(angle) * radius),
                ],
            )
        )
    return paths


def _machine_panel(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    paths = {
        _ROLE_STRUCTURE: [
            canvas.polygon(
                "panel",
                [
                    (canvas.left, canvas.bottom),
                    (canvas.right, canvas.bottom),
                    (canvas.right, canvas.top),
                    (canvas.left, canvas.top),
                ],
            )
        ],
        _ROLE_DETAIL: [],
        _ROLE_ACCENT: [],
    }
    columns = max(2, canvas.detail_level)
    rows = max(2, canvas.detail_level)
    cell_width = canvas.width * 0.72 / columns
    cell_height = canvas.height * 0.72 / rows
    random = context.random.scalar("controls")
    for row in range(rows):
        for column in range(columns):
            x = canvas.left * 0.72 + (column + 0.5) * cell_width
            y = canvas.bottom * 0.72 + (row + 0.5) * cell_height
            radius = min(cell_width, cell_height) * random.uniform(0.16, 0.3)
            paths[_ROLE_DETAIL].append(
                canvas.ellipse(f"control-{row}-{column}", x, y, radius, radius)
            )
    return paths


def _big_top(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    shoulder_y = canvas.top * 0.18
    paths = {
        _ROLE_STRUCTURE: [
            canvas.line(
                "tent",
                [
                    (canvas.left, canvas.bottom),
                    (canvas.left * 0.68, shoulder_y),
                    (0, canvas.top),
                    (canvas.right * 0.68, shoulder_y),
                    (canvas.right, canvas.bottom),
                    (canvas.left, canvas.bottom),
                ],
            )
        ],
        _ROLE_DETAIL: [],
        _ROLE_ACCENT: [
            canvas.line("mast", [(0, canvas.bottom), (0, canvas.top)]),
            canvas.line(
                "flag",
                [
                    (0, canvas.top),
                    (canvas.width * 0.18, canvas.top * 0.88),
                    (0, canvas.top * 0.76),
                ],
            ),
        ],
    }
    for index, x in enumerate(
        _even_positions(canvas.left * 0.7, canvas.right * 0.7, canvas.detail_level + 1)
    ):
        paths[_ROLE_DETAIL].append(
            canvas.line(f"stripe-{index}", [(0, canvas.top), (x, canvas.bottom)])
        )
    return paths


def _ferris_wheel(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    center_y = canvas.top * 0.1
    radius = min(canvas.width, canvas.height) * 0.38
    spoke_count = 6 + canvas.detail_level * 2
    paths = {
        _ROLE_STRUCTURE: [
            canvas.ellipse("wheel", 0, center_y, radius, radius),
            canvas.line(
                "supports",
                [
                    (-radius * 0.72, canvas.bottom),
                    (0, center_y),
                    (radius * 0.72, canvas.bottom),
                ],
            ),
        ],
        _ROLE_DETAIL: [],
        _ROLE_ACCENT: [],
    }
    phase = context.random.scalar("cabins").uniform(0, math.tau / spoke_count)
    cabin_radius = max(MINIMUM_FEATURE_MM * 0.25, radius * 0.05)
    for index in range(spoke_count):
        angle = phase + math.tau * index / spoke_count
        x = math.cos(angle) * radius
        y = center_y + math.sin(angle) * radius
        paths[_ROLE_DETAIL].append(canvas.line(f"spoke-{index}", [(0, center_y), (x, y)]))
        if index % 2 == 0:
            paths[_ROLE_ACCENT].append(
                canvas.ellipse(f"cabin-{index}", x, y, cabin_radius, cabin_radius)
            )
    return paths


def _booth(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    awning_y = canvas.top * 0.42
    paths = {
        _ROLE_STRUCTURE: [
            canvas.polygon(
                "booth",
                [
                    (canvas.left * 0.8, canvas.bottom),
                    (canvas.right * 0.8, canvas.bottom),
                    (canvas.right * 0.8, awning_y),
                    (canvas.left * 0.8, awning_y),
                ],
            )
        ],
        _ROLE_DETAIL: [
            canvas.line(
                "counter",
                [
                    (canvas.left * 0.68, canvas.bottom * 0.18),
                    (canvas.right * 0.68, canvas.bottom * 0.18),
                ],
            )
        ],
        _ROLE_ACCENT: [
            canvas.line(
                "awning",
                [
                    (canvas.left * 0.9, awning_y),
                    (canvas.left * 0.72, canvas.top),
                    (canvas.right * 0.72, canvas.top),
                    (canvas.right * 0.9, awning_y),
                ],
            )
        ],
    }
    for index, x in enumerate(
        _even_positions(canvas.left * 0.7, canvas.right * 0.7, canvas.detail_level + 1)
    ):
        paths[_ROLE_DETAIL].append(
            canvas.line(f"awning-stripe-{index}", [(x, awning_y), (x, canvas.top)])
        )
    return paths


def _carousel(context: GlyphGenerationContext, canvas: _Canvas) -> dict[str, list[DesignPath]]:
    canopy_y = canvas.top * 0.45
    platform_y = canvas.bottom * 0.62
    paths = {
        _ROLE_STRUCTURE: [
            canvas.line(
                "canopy",
                [
                    (canvas.left, canopy_y),
                    (0, canvas.top),
                    (canvas.right, canopy_y),
                ],
            ),
            canvas.line("platform", [(canvas.left, platform_y), (canvas.right, platform_y)]),
            canvas.line("center-pole", [(0, platform_y), (0, canvas.top)]),
        ],
        _ROLE_DETAIL: [],
        _ROLE_ACCENT: [],
    }
    for index, x in enumerate(
        _even_positions(canvas.left * 0.78, canvas.right * 0.78, canvas.detail_level + 2)
    ):
        paths[_ROLE_DETAIL].append(canvas.line(f"pole-{index}", [(x, platform_y), (x, canopy_y)]))
        if index % 2 == 0:
            paths[_ROLE_ACCENT].append(
                canvas.line(
                    f"horse-{index}",
                    [
                        (x - canvas.width * 0.035, (platform_y + canopy_y) / 2),
                        (x + canvas.width * 0.035, (platform_y + canopy_y) / 2),
                    ],
                )
            )
    return paths


_SPECS = (
    _FamilySpec("city-building", "City building", "city", ("city", "building"), 6, _building),
    _FamilySpec("city-tower", "City tower", "city", ("city", "tower", "landmark"), 8, _tower),
    _FamilySpec(
        "city-station", "City station", "city", ("city", "transit", "landmark"), 10, _station
    ),
    _FamilySpec("city-bridge", "City bridge", "city", ("city", "bridge"), 10, _bridge),
    _FamilySpec(
        "industrial-factory", "Factory", "industrial", ("industrial", "factory"), 8, _factory
    ),
    _FamilySpec("industrial-silo", "Silo or tank", "industrial", ("industrial", "silo"), 7, _silo),
    _FamilySpec(
        "industrial-crane", "Crane", "industrial", ("industrial", "crane", "landmark"), 9, _crane
    ),
    _FamilySpec(
        "industrial-turbine",
        "Turbine",
        "industrial",
        ("industrial", "turbine", "landmark"),
        9,
        _turbine,
    ),
    _FamilySpec(
        "industrial-machine-panel",
        "Machine panel",
        "industrial",
        ("industrial", "machine"),
        7,
        _machine_panel,
    ),
    _FamilySpec(
        "fairground-big-top",
        "Big-top tent",
        "fairground",
        ("fairground", "circus", "landmark"),
        10,
        _big_top,
    ),
    _FamilySpec(
        "fairground-ferris-wheel",
        "Ferris wheel",
        "fairground",
        ("fairground", "wheel", "landmark"),
        11,
        _ferris_wheel,
    ),
    _FamilySpec(
        "fairground-booth", "Fairground booth", "fairground", ("fairground", "booth"), 7, _booth
    ),
    _FamilySpec(
        "fairground-carousel",
        "Carousel",
        "fairground",
        ("fairground", "carousel"),
        9,
        _carousel,
    ),
)


def _manifest(spec: _FamilySpec) -> GlyphFamilyManifest:
    return GlyphFamilyManifest(
        family_id=spec.family_id,
        version=FAMILY_VERSION,
        name=spec.name,
        description=f"Deterministic procedural {spec.name.lower()} glyph.",
        themes=[spec.theme],
        tags=list(spec.tags),
        semantic_roles=_COMMON_ROLES,
        connection_types=_CONNECTION_TYPES,
        parameters=[
            GlyphFamilyParameter(
                key="detail_level",
                label="Detail level",
                kind="integer",
                default=3,
                description="Requested internal detail, capped by quality and physical spacing.",
                minimum=1,
                maximum=5,
                step=1,
            ),
            GlyphFamilyParameter(
                key="variant",
                label="Variant",
                kind="enum",
                default="classic",
                options=[
                    GlyphParameterOption(value="classic", label="Classic"),
                    GlyphParameterOption(value="ornate", label="Ornate"),
                ],
            ),
        ],
        minimum_size_mm=spec.minimum_size_mm,
        maximum_size_mm=120,
        allowed_scale_range=_SCALE_RANGE,
        allowed_rotation_range=_ROTATION_RANGE,
        maximum_complexity_score=500,
    )


def _ports(canvas: _Canvas) -> list[GlyphPort]:
    return [
        GlyphPort(
            port_id="west",
            position=Point(x=canvas.left, y=0),
            outward_direction=UnitVector(x=-1, y=0),
            connection_type="structural",
            capacity=2,
            preferred_connector_family="double",
            preferred_semantic_role="connector-primary",
            clearance_mm=MINIMUM_FEATURE_MM,
        ),
        GlyphPort(
            port_id="east",
            position=Point(x=canvas.right, y=0),
            outward_direction=UnitVector(x=1, y=0),
            connection_type="structural",
            capacity=2,
            preferred_connector_family="double",
            preferred_semantic_role="connector-primary",
            clearance_mm=MINIMUM_FEATURE_MM,
        ),
        GlyphPort(
            port_id="north",
            position=Point(x=0, y=canvas.top),
            outward_direction=UnitVector(x=0, y=1),
            connection_type="signal",
            preferred_connector_family="single",
            preferred_semantic_role="connector-secondary",
            clearance_mm=MINIMUM_FEATURE_MM,
        ),
        GlyphPort(
            port_id="south",
            position=Point(x=0, y=canvas.bottom),
            outward_direction=UnitVector(x=0, y=-1),
            connection_type="pedestrian",
            preferred_connector_family="ladder",
            preferred_semantic_role="connector-secondary",
            clearance_mm=MINIMUM_FEATURE_MM,
        ),
    ]


def _make_generator(
    spec: _FamilySpec,
    manifest: GlyphFamilyManifest,
) -> Callable[[GlyphGenerationContext], Glyph]:
    def generate(context: GlyphGenerationContext) -> Glyph:
        canvas = _Canvas(context)
        context.checkpoint()
        path_groups = spec.generator(context, canvas)
        context.checkpoint()
        role_paths = [
            GlyphRolePaths(semantic_role=role, paths=paths)
            for role, paths in path_groups.items()
            if paths
        ]
        path_count = sum(len(group.paths) for group in role_paths)
        command_count = sum(len(path.commands) for group in role_paths for path in group.paths)
        return Glyph(
            glyph_id=context.glyph_id,
            family_id=spec.family_id,
            family_version=manifest.version,
            local_bounds=GlyphBounds(
                min_x_mm=-canvas.half_width,
                min_y_mm=-canvas.half_height,
                max_x_mm=canvas.half_width,
                max_y_mm=canvas.half_height,
            ),
            role_paths=role_paths,
            obstacle=GlyphObstacle(
                polygon=_rect(
                    canvas.left * 0.94,
                    canvas.bottom * 0.94,
                    canvas.right * 0.94,
                    canvas.top * 0.94,
                )
            ),
            clearance=GlyphClearance(
                polygon=_rect(canvas.left, canvas.bottom, canvas.right, canvas.top),
                minimum_gap_mm=MINIMUM_FEATURE_MM,
            ),
            ports=_ports(canvas),
            anchors=[
                GlyphAnchor(anchor_id="center", position=Point(x=0, y=0)),
                GlyphAnchor(
                    anchor_id="baseline",
                    position=Point(x=0, y=canvas.bottom),
                    kind="baseline",
                ),
            ],
            complexity_score=float(command_count),
            tags=list(spec.tags),
            allowed_scale_range=manifest.allowed_scale_range,
            allowed_rotation_range=manifest.allowed_rotation_range,
            metadata=glyph_metadata(
                context,
                detail_level=canvas.detail_level,
                minimum_feature_mm=MINIMUM_FEATURE_MM,
                path_count=path_count,
                theme=spec.theme,
                variant=canvas.variant,
            ),
        )

    return generate


def builtin_glyph_families() -> tuple[BuiltinGlyphFamily, ...]:
    families: list[BuiltinGlyphFamily] = []
    for spec in _SPECS:
        manifest = _manifest(spec)
        families.append(BuiltinGlyphFamily(manifest, _make_generator(spec, manifest)))
    return tuple(families)


def create_builtin_glyph_registry() -> GlyphFamilyRegistry:
    registry = GlyphFamilyRegistry()
    for family in builtin_glyph_families():
        registry.register(family)
    return registry
