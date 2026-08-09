from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from itertools import pairwise
from typing import Any, Literal, cast

from pydantic import Field

from plotter_core.glyphscape.builtins import create_builtin_glyph_registry
from plotter_core.glyphscape.composition import (
    CandidateConnection,
    PlacedGlyph,
    PlacedPort,
    RoutedConnection,
    build_candidate_connections,
    decorate_connections,
    route_connections,
    select_connection_graph,
)
from plotter_core.glyphscape.hybrid import (
    LockedRoadEdge,
    LockedRoadGraph,
    RoadClass,
    RoadJunctionCandidate,
    build_locked_road_graph,
    build_road_junction_candidates,
)
from plotter_core.glyphscape.models import GlyphPolygon
from plotter_core.maps import (
    clip_osm_polygon,
    create_osm_page_transform,
    project_osm_coordinate,
)
from plotter_core.models import (
    CloseCommand,
    CubicCommand,
    DesignDiagnostic,
    DesignDocument,
    DesignLayer,
    DesignMetadata,
    DesignPath,
    LineCommand,
    MoveCommand,
    Point,
    ProjectRecipe,
    QuadraticCommand,
    StrictModel,
    canonical_sha256,
)
from plotter_core.modes import GenerationContext

HYBRID_MODE_ID = "builtin.map-glyphscape"
HYBRID_MODE_VERSION = "1.0.0"
LandscapeKind = Literal["water", "park"]
LandscapeBehavior = Literal["exclude", "fill", "ignore"]
ConnectorDecoration = Literal["single", "double", "wave", "zigzag", "ladder", "beads", "bundle"]
_EPSILON = 1e-8


class MapGlyphCell(StrictModel):
    cell_id: str
    source_way_id: int
    polygon: GlyphPolygon
    center: Point
    width_mm: float = Field(gt=0)
    height_mm: float = Field(gt=0)
    area_mm2: float = Field(gt=0)
    orientation_radians: float
    building_kind: str


class MapLandmarkCandidate(StrictModel):
    landmark_id: str
    source_element_id: int
    position: Point
    category: str
    name: str | None = None
    tags: dict[str, str]


class LandscapeRegion(StrictModel):
    region_id: str
    source_way_id: int
    kind: LandscapeKind
    polygon: GlyphPolygon
    behavior: LandscapeBehavior


class HybridPortAttachment(StrictModel):
    attachment_id: str
    glyph_id: str
    port_ref: str
    road_edge_id: str
    road_class: RoadClass
    port_point: Point
    road_point: Point
    distance_mm: float = Field(ge=0)


class HybridStatistics(StrictModel):
    locked_edge_count: int = Field(ge=0)
    junction_count: int = Field(ge=0)
    building_cell_count: int = Field(ge=0)
    replaced_building_count: int = Field(ge=0)
    poi_candidate_count: int = Field(ge=0)
    poi_landmark_count: int = Field(ge=0)
    landscape_region_count: int = Field(ge=0)
    attachment_count: int = Field(ge=0)
    secondary_connector_count: int = Field(ge=0)
    blocked_water_edge_count: int = Field(ge=0)
    path_count: int = Field(ge=0)
    vertex_count: int = Field(ge=0)
    topology_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    geometry_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")


class MapGlyphscapeComposition(StrictModel):
    schema_version: Literal[1] = 1
    graph: LockedRoadGraph
    junctions: list[RoadJunctionCandidate]
    building_cells: list[MapGlyphCell]
    landmark_candidates: list[MapLandmarkCandidate]
    landscapes: list[LandscapeRegion]
    glyphs: list[PlacedGlyph]
    attachments: list[HybridPortAttachment]
    secondary_connections: list[RoutedConnection]
    statistics: HybridStatistics
    diagnostics: list[DesignDiagnostic]
    document: DesignDocument


def _parameter_float(context: GenerationContext, key: str) -> float:
    value = context.parameters[key]
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise TypeError(f"{key} must be numeric")
    return float(value)


def _parameter_int(context: GenerationContext, key: str) -> int:
    value = context.parameters[key]
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"{key} must be an integer")
    return value


def _parameter_text(context: GenerationContext, key: str) -> str:
    value = context.parameters[key]
    if not isinstance(value, str):
        raise TypeError(f"{key} must be text")
    return value


def _parameter_bool(context: GenerationContext, key: str) -> bool:
    value = context.parameters[key]
    if not isinstance(value, bool):
        raise TypeError(f"{key} must be boolean")
    return value


def _snapshot_nodes(
    snapshot: Mapping[str, Any],
    recipe: ProjectRecipe,
) -> tuple[dict[int, tuple[float, float]], dict[int, dict[str, Any]]]:
    metadata = recipe.osm.snapshot
    if metadata is None:
        raise ValueError("fetch and freeze an OSM snapshot before generating a map glyphscape")
    elements = snapshot.get("elements")
    if not isinstance(elements, list):
        raise ValueError("OSM snapshot must contain an elements list")
    metric: dict[int, tuple[float, float]] = {}
    raw_nodes: dict[int, dict[str, Any]] = {}
    for element in elements:
        if (
            isinstance(element, dict)
            and element.get("type") == "node"
            and isinstance(element.get("id"), int)
            and isinstance(element.get("lat"), int | float)
            and isinstance(element.get("lon"), int | float)
        ):
            node_id = element["id"]
            metric[node_id] = project_osm_coordinate(
                element["lat"], element["lon"], metadata.bounds
            )
            raw_nodes[node_id] = element
    return metric, raw_nodes


def _page_rectangle(recipe: ProjectRecipe) -> tuple[float, float, float, float]:
    return (
        recipe.page.safe_min.x,
        recipe.page.safe_min.y,
        recipe.page.safe_max.x,
        recipe.page.safe_max.y,
    )


def _polygon_center(points: Sequence[Point]) -> Point:
    return Point(
        x=sum(point.x for point in points) / len(points),
        y=sum(point.y for point in points) / len(points),
    )


def _polygon_bounds(points: Sequence[Point]) -> tuple[float, float, float, float]:
    return (
        min(point.x for point in points),
        min(point.y for point in points),
        max(point.x for point in points),
        max(point.y for point in points),
    )


def _polygon_area(points: Sequence[Point]) -> float:
    return (
        abs(
            sum(
                first.x * second.y - second.x * first.y
                for first, second in zip(points, [*points[1:], points[0]], strict=True)
            )
        )
        / 2
    )


def _closed_feature_polygon(
    refs: object,
    metric_nodes: Mapping[int, tuple[float, float]],
    transform: Any,
    recipe: ProjectRecipe,
) -> list[Point]:
    if not isinstance(refs, list) or len(refs) < 4 or refs[0] != refs[-1]:
        return []
    metric = [metric_nodes[ref] for ref in refs if isinstance(ref, int) and ref in metric_nodes]
    if len(metric) < 4:
        return []
    clipped = clip_osm_polygon(
        [transform(point) for point in metric],
        _page_rectangle(recipe),
    )
    if len(clipped) < 4:
        return []
    points = [Point(x=x, y=y) for x, y in clipped[:-1]]
    if len({(point.x, point.y) for point in points}) < 3:
        return []
    return points


def extract_building_cells(
    snapshot: Mapping[str, Any],
    recipe: ProjectRecipe,
) -> list[MapGlyphCell]:
    metric_nodes, _ = _snapshot_nodes(snapshot, recipe)
    metadata = recipe.osm.snapshot
    assert metadata is not None
    transform = create_osm_page_transform(metadata.bounds, recipe)
    elements = snapshot["elements"]
    cells: list[MapGlyphCell] = []
    for element in elements:
        if not isinstance(element, dict) or element.get("type") != "way":
            continue
        tags = element.get("tags")
        way_id = element.get("id")
        if not isinstance(tags, dict) or "building" not in tags or not isinstance(way_id, int):
            continue
        points = _closed_feature_polygon(element.get("nodes"), metric_nodes, transform, recipe)
        if not points:
            continue
        bounds = _polygon_bounds(points)
        area = _polygon_area(points)
        if area <= _EPSILON:
            continue
        longest_index = max(
            range(len(points)),
            key=lambda index: math.dist(
                (points[index].x, points[index].y),
                (
                    points[(index + 1) % len(points)].x,
                    points[(index + 1) % len(points)].y,
                ),
            ),
        )
        first = points[longest_index]
        second = points[(longest_index + 1) % len(points)]
        building_kind = tags.get("building")
        cells.append(
            MapGlyphCell(
                cell_id=f"osm-building-{way_id}",
                source_way_id=way_id,
                polygon=GlyphPolygon(vertices=points),
                center=_polygon_center(points),
                width_mm=bounds[2] - bounds[0],
                height_mm=bounds[3] - bounds[1],
                area_mm2=area,
                orientation_radians=math.atan2(second.y - first.y, second.x - first.x),
                building_kind=building_kind if isinstance(building_kind, str) else "yes",
            )
        )
    return sorted(cells, key=lambda cell: cell.cell_id)


def extract_landmark_candidates(
    snapshot: Mapping[str, Any],
    recipe: ProjectRecipe,
) -> list[MapLandmarkCandidate]:
    metric_nodes, raw_nodes = _snapshot_nodes(snapshot, recipe)
    metadata = recipe.osm.snapshot
    assert metadata is not None
    transform = create_osm_page_transform(metadata.bounds, recipe)
    rectangle = _page_rectangle(recipe)
    candidates: list[MapLandmarkCandidate] = []
    for node_id, element in sorted(raw_nodes.items()):
        tags = element.get("tags")
        if not isinstance(tags, dict):
            continue
        category_key = next(
            (key for key in ("amenity", "tourism", "historic") if isinstance(tags.get(key), str)),
            None,
        )
        if category_key is None:
            continue
        x, y = transform(metric_nodes[node_id])
        if not (rectangle[0] <= x <= rectangle[2] and rectangle[1] <= y <= rectangle[3]):
            continue
        string_tags = {
            str(key): value
            for key, value in tags.items()
            if isinstance(key, str) and isinstance(value, str)
        }
        name = string_tags.get("name")
        candidates.append(
            MapLandmarkCandidate(
                landmark_id=f"osm-poi-{node_id}",
                source_element_id=node_id,
                position=Point(x=x, y=y),
                category=f"{category_key}:{string_tags[category_key]}",
                name=name,
                tags=string_tags,
            )
        )
    return candidates


def extract_landscape_regions(
    snapshot: Mapping[str, Any],
    recipe: ProjectRecipe,
    *,
    water_behavior: LandscapeBehavior,
    park_behavior: LandscapeBehavior,
) -> list[LandscapeRegion]:
    metric_nodes, _ = _snapshot_nodes(snapshot, recipe)
    metadata = recipe.osm.snapshot
    assert metadata is not None
    transform = create_osm_page_transform(metadata.bounds, recipe)
    regions: list[LandscapeRegion] = []
    for element in snapshot["elements"]:
        if not isinstance(element, dict) or element.get("type") != "way":
            continue
        tags = element.get("tags")
        way_id = element.get("id")
        if not isinstance(tags, dict) or not isinstance(way_id, int):
            continue
        kind: LandscapeKind | None = None
        behavior: LandscapeBehavior
        if tags.get("natural") in {"water", "bay"} or tags.get("waterway") == "riverbank":
            kind, behavior = "water", water_behavior
        elif tags.get("leisure") in {"park", "garden", "nature_reserve"} or tags.get("landuse") in {
            "forest",
            "grass",
            "meadow",
            "recreation_ground",
            "village_green",
        }:
            kind, behavior = "park", park_behavior
        else:
            continue
        points = _closed_feature_polygon(element.get("nodes"), metric_nodes, transform, recipe)
        if not points:
            continue
        regions.append(
            LandscapeRegion(
                region_id=f"osm-{kind}-{way_id}",
                source_way_id=way_id,
                kind=kind,
                polygon=GlyphPolygon(vertices=points),
                behavior=behavior,
            )
        )
    return sorted(regions, key=lambda region: region.region_id)


def apply_geographic_fidelity(
    graph: LockedRoadGraph,
    fidelity: float,
    *,
    grid_mm: float = 6.0,
) -> LockedRoadGraph:
    if not 0 <= fidelity <= 100:
        raise ValueError("geographic fidelity must be between 0 and 100")
    if fidelity == 100:
        return graph
    stylization = 1 - fidelity / 100

    def stylize(point: Point) -> Point:
        snapped = Point(
            x=round(point.x / grid_mm) * grid_mm,
            y=round(point.y / grid_mm) * grid_mm,
        )
        return Point(
            x=point.x + (snapped.x - point.x) * stylization,
            y=point.y + (snapped.y - point.y) * stylization,
        )

    nodes = [node.model_copy(update={"point": stylize(node.point)}) for node in graph.nodes]
    by_id = {node.node_id: node for node in nodes}
    edges: list[LockedRoadEdge] = []
    for edge in graph.edges:
        points = [
            by_id[edge.source_node_ref].point,
            *(stylize(point) for point in edge.points[1:-1]),
            by_id[edge.target_node_ref].point,
        ]
        if not any(
            math.dist((first.x, first.y), (second.x, second.y)) > _EPSILON
            for first, second in pairwise(points)
        ):
            points = edge.points
        edges.append(edge.model_copy(update={"points": points}))
    updated = graph.model_copy(
        update={
            "nodes": nodes,
            "edges": edges,
            "normalized_sha256": "0" * 64,
        }
    )
    return updated.model_copy(
        update={
            "normalized_sha256": canonical_sha256(updated.model_dump(exclude={"normalized_sha256"}))
        }
    )


def _segments_intersect(a: Point, b: Point, c: Point, d: Point) -> bool:
    def cross(first: Point, second: Point, third: Point) -> float:
        return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (
            third.x - first.x
        )

    first = cross(a, b, c)
    second = cross(a, b, d)
    third = cross(c, d, a)
    fourth = cross(c, d, b)
    return first * second < -_EPSILON and third * fourth < -_EPSILON


def _polyline_crosses_polygon(points: Sequence[Point], polygon: GlyphPolygon) -> bool:
    if any(polygon.contains(point) for point in points):
        return True
    boundary = [*polygon.vertices, polygon.vertices[0]]
    return any(
        _segments_intersect(first, second, third, fourth)
        for first, second in pairwise(points)
        for third, fourth in pairwise(boundary)
    )


def filter_water_crossings(
    graph: LockedRoadGraph,
    landscapes: Sequence[LandscapeRegion],
    *,
    allow_crossings: bool,
) -> tuple[LockedRoadGraph, int]:
    excluded_water = [
        region for region in landscapes if region.kind == "water" and region.behavior == "exclude"
    ]
    if allow_crossings or not excluded_water:
        return graph, 0
    kept = [
        edge
        for edge in graph.edges
        if edge.bridge
        or not any(
            _polyline_crosses_polygon(edge.points, region.polygon) for region in excluded_water
        )
    ]
    removed = len(graph.edges) - len(kept)
    if not removed:
        return graph, 0
    diagnostics = [
        *graph.diagnostics,
        DesignDiagnostic(
            code="hybrid-water-road-blocked",
            message=(
                f"{removed} non-bridge locked road edges crossed excluded water and were blocked."
            ),
        ),
    ]
    updated = graph.model_copy(
        update={
            "edges": kept,
            "diagnostics": diagnostics,
            "normalized_sha256": "0" * 64,
        }
    )
    return (
        updated.model_copy(
            update={
                "normalized_sha256": canonical_sha256(
                    updated.model_dump(exclude={"normalized_sha256"})
                )
            }
        ),
        removed,
    )


def _translate_point(point: Point, center: Point) -> Point:
    return Point(x=point.x + center.x, y=point.y + center.y)


def _translate_polygon(polygon: GlyphPolygon, center: Point) -> GlyphPolygon:
    return GlyphPolygon(vertices=[_translate_point(point, center) for point in polygon.vertices])


def _translate_path(path: DesignPath, center: Point, prefix: str) -> DesignPath:
    commands: list[MoveCommand | LineCommand | QuadraticCommand | CubicCommand | CloseCommand] = []
    for command in path.commands:
        if isinstance(command, MoveCommand):
            commands.append(MoveCommand(point=_translate_point(command.point, center)))
        elif isinstance(command, LineCommand):
            commands.append(LineCommand(point=_translate_point(command.point, center)))
        elif isinstance(command, QuadraticCommand):
            commands.append(
                QuadraticCommand(
                    control=_translate_point(command.control, center),
                    point=_translate_point(command.point, center),
                )
            )
        elif isinstance(command, CubicCommand):
            commands.append(
                CubicCommand(
                    control1=_translate_point(command.control1, center),
                    control2=_translate_point(command.control2, center),
                    point=_translate_point(command.point, center),
                )
            )
        else:
            commands.append(CloseCommand())
    return path.model_copy(update={"path_id": f"{prefix}-{path.path_id}", "commands": commands})


def _family_ids(theme: str, *, landmarks: bool) -> list[str]:
    manifests = create_builtin_glyph_registry().manifests()
    return [
        manifest.family_id
        for manifest in manifests
        if theme in manifest.themes and (("landmark" in manifest.tags) == landmarks)
    ]


def _place_source_glyph(
    context: GenerationContext,
    *,
    instance_id: str,
    center: Point,
    requested_size: float,
    family_id: str,
    is_landmark: bool,
    source_region_id: str,
) -> PlacedGlyph | None:
    registry = create_builtin_glyph_registry()
    manifest = registry.get(family_id).manifest
    if requested_size < manifest.minimum_size_mm:
        return None
    size = min(manifest.maximum_size_mm, requested_size)
    glyph = registry.generate(
        family_id,
        instance_id,
        seed=f"{context.recipe.mode.seed}:{instance_id}",
        width_mm=size,
        height_mm=size,
        quality=context.quality,
        parameters={
            "detail_level": _parameter_int(context, "detail_level"),
            "variant": "ornate" if is_landmark else "classic",
        },
        cancellation=context.cancellation,
    )
    ports = [
        PlacedPort(
            port_ref=f"{instance_id}:{port.port_id}",
            glyph_id=instance_id,
            port_id=port.port_id,
            position=_translate_point(port.position, center),
            connection_type=port.connection_type,
            capacity=port.capacity,
            preferred_connector_family=port.preferred_connector_family,
            preferred_semantic_role=port.preferred_semantic_role,
        )
        for port in glyph.ports
    ]
    return PlacedGlyph(
        instance_id=instance_id,
        region_id=source_region_id,
        family_id=family_id,
        theme=_parameter_text(context, "theme"),
        is_landmark=is_landmark,
        center=center,
        width_mm=size,
        height_mm=size,
        glyph=glyph,
        obstacle=_translate_polygon(glyph.obstacle.polygon, center),
        clearance=_translate_polygon(glyph.clearance.polygon, center),
        ports=ports,
    )


def place_map_glyphs(
    context: GenerationContext,
    cells: Sequence[MapGlyphCell],
    landmarks: Sequence[MapLandmarkCandidate],
    landscapes: Sequence[LandscapeRegion],
) -> tuple[list[PlacedGlyph], int, int]:
    theme = _parameter_text(context, "theme")
    building_families = _family_ids(theme, landmarks=False)
    landmark_families = _family_ids(theme, landmarks=True)
    if not building_families:
        building_families = _family_ids("city", landmarks=False)
    if not landmark_families:
        landmark_families = _family_ids("city", landmarks=True)
    excluded = [region.polygon for region in landscapes if region.behavior == "exclude"]
    probability = _parameter_float(context, "building_replacement_probability")
    rng = context.random.scalar("hybrid-building-replacement")
    glyphs: list[PlacedGlyph] = []
    replaced = 0
    for index, cell in enumerate(cells):
        context.checkpoint("replacing buildings", index, len(cells))
        if rng.random() > probability or any(mask.contains(cell.center) for mask in excluded):
            continue
        family_id = building_families[rng.randrange(len(building_families))]
        placement = _place_source_glyph(
            context,
            instance_id=f"building-glyph-{cell.source_way_id}",
            center=cell.center,
            requested_size=min(cell.width_mm, cell.height_mm),
            family_id=family_id,
            is_landmark=False,
            source_region_id=cell.cell_id,
        )
        if placement is not None:
            glyphs.append(placement)
            replaced += 1

    landmark_limit = _parameter_int(context, "poi_landmark_limit")
    for index, candidate in enumerate(landmarks[:landmark_limit]):
        if any(mask.contains(candidate.position) for mask in excluded):
            continue
        family_id = landmark_families[index % len(landmark_families)]
        placement = _place_source_glyph(
            context,
            instance_id=f"poi-glyph-{candidate.source_element_id}",
            center=candidate.position,
            requested_size=_parameter_float(context, "landmark_size_mm"),
            family_id=family_id,
            is_landmark=True,
            source_region_id=candidate.landmark_id,
        )
        if placement is not None:
            glyphs.append(placement)
    return sorted(glyphs, key=lambda glyph: glyph.instance_id), replaced, len(glyphs) - replaced


def _nearest_point_on_segment(point: Point, start: Point, end: Point) -> Point:
    dx, dy = end.x - start.x, end.y - start.y
    denominator = dx * dx + dy * dy
    if denominator <= _EPSILON:
        return start
    fraction = max(
        0.0,
        min(1.0, ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator),
    )
    return Point(x=start.x + dx * fraction, y=start.y + dy * fraction)


def attach_glyph_ports_to_roads(
    glyphs: Sequence[PlacedGlyph],
    graph: LockedRoadGraph,
    *,
    maximum_distance_mm: float,
) -> list[HybridPortAttachment]:
    attachments: list[HybridPortAttachment] = []
    for glyph in glyphs:
        options: list[tuple[float, PlacedPort, LockedRoadEdge, Point]] = []
        for port in glyph.ports:
            for edge in graph.edges:
                for start, end in pairwise(edge.points):
                    road_point = _nearest_point_on_segment(port.position, start, end)
                    distance = math.dist(
                        (port.position.x, port.position.y),
                        (road_point.x, road_point.y),
                    )
                    options.append((distance, port, edge, road_point))
        if not options:
            continue
        distance, port, edge, road_point = min(
            options,
            key=lambda item: (item[0], item[1].port_ref, item[2].edge_id),
        )
        if distance > maximum_distance_mm:
            continue
        attachments.append(
            HybridPortAttachment(
                attachment_id=f"attach-{glyph.instance_id}-{edge.edge_id}",
                glyph_id=glyph.instance_id,
                port_ref=port.port_ref,
                road_edge_id=edge.edge_id,
                road_class=edge.road_class,
                port_point=port.position,
                road_point=road_point,
                distance_mm=distance,
            )
        )
    return attachments


def build_secondary_connectors(
    context: GenerationContext,
    glyphs: Sequence[PlacedGlyph],
    landscapes: Sequence[LandscapeRegion],
) -> tuple[list[CandidateConnection], list[RoutedConnection], list[DesignDiagnostic]]:
    candidates = build_candidate_connections(glyphs)
    selected, diagnostics = select_connection_graph(context, glyphs, candidates)
    routes, route_diagnostics = route_connections(context, glyphs, selected)
    diagnostics.extend(route_diagnostics)
    excluded = [region.polygon for region in landscapes if region.behavior == "exclude"]
    kept = [
        route
        for route in routes
        if not any(_polyline_crosses_polygon(route.points, polygon) for polygon in excluded)
    ]
    removed = len(routes) - len(kept)
    if removed:
        diagnostics.append(
            DesignDiagnostic(
                code="hybrid-secondary-mask-blocked",
                message=f"{removed} secondary connectors crossed excluded landscape masks.",
            )
        )
    return candidates, kept, diagnostics


def connector_family_for_road_class(road_class: RoadClass) -> ConnectorDecoration:
    return cast(
        ConnectorDecoration,
        {
            "major": "bundle",
            "secondary": "double",
            "local": "single",
            "path": "beads",
        }[road_class],
    )


def _polyline_path(
    path_id: str,
    points: Sequence[Point],
    **metadata: str | float | int | bool,
) -> DesignPath:
    return DesignPath(
        path_id=path_id,
        commands=[
            MoveCommand(point=points[0]),
            *(LineCommand(point=point) for point in points[1:]),
        ],
        metadata=metadata,
    )


def _closed_path(
    path_id: str,
    points: Sequence[Point],
    **metadata: str | float | int | bool,
) -> DesignPath:
    return DesignPath(
        path_id=path_id,
        commands=[
            MoveCommand(point=points[0]),
            *(LineCommand(point=point) for point in points[1:]),
            CloseCommand(),
        ],
        closed=True,
        metadata=metadata,
    )


def _junction_path(candidate: RoadJunctionCandidate, radius: float) -> DesignPath:
    points = [
        Point(
            x=candidate.position.x + math.cos(math.tau * index / 8) * radius,
            y=candidate.position.y + math.sin(math.tau * index / 8) * radius,
        )
        for index in range(8)
    ]
    return _closed_path(
        candidate.junction_id,
        points,
        hybrid_kind="junction",
        road_class=candidate.dominant_road_class,
    )


def _landscape_paths(regions: Sequence[LandscapeRegion]) -> list[DesignPath]:
    paths: list[DesignPath] = []
    for region in regions:
        if region.behavior == "ignore":
            continue
        paths.append(
            _closed_path(
                region.region_id,
                region.polygon.vertices,
                hybrid_kind="landscape",
                landscape_kind=region.kind,
                behavior=region.behavior,
            )
        )
        if region.behavior != "fill":
            continue
        bounds = _polygon_bounds(region.polygon.vertices)
        y = math.ceil(bounds[1] / 4.0) * 4.0
        hatch_index = 0
        boundary = [*region.polygon.vertices, region.polygon.vertices[0]]
        while y < bounds[3]:
            intersections: list[float] = []
            for first, second in pairwise(boundary):
                if (first.y <= y < second.y) or (second.y <= y < first.y):
                    fraction = (y - first.y) / (second.y - first.y)
                    intersections.append(first.x + fraction * (second.x - first.x))
            intersections.sort()
            for left, right in zip(intersections[::2], intersections[1::2], strict=False):
                if right - left <= _EPSILON:
                    continue
                paths.append(
                    _polyline_path(
                        f"{region.region_id}-fill-{hatch_index}",
                        [Point(x=left, y=y), Point(x=right, y=y)],
                        hybrid_kind="landscape-filler",
                        landscape_kind=region.kind,
                    )
                )
                hatch_index += 1
            y += 4.0
    return paths


def _build_document(
    context: GenerationContext,
    graph: LockedRoadGraph,
    junctions: Sequence[RoadJunctionCandidate],
    landscapes: Sequence[LandscapeRegion],
    glyphs: Sequence[PlacedGlyph],
    attachments: Sequence[HybridPortAttachment],
    secondary: Sequence[RoutedConnection],
    diagnostics: list[DesignDiagnostic],
) -> DesignDocument:
    locked_paths = [
        _polyline_path(
            edge.edge_id,
            edge.points,
            hybrid_kind="locked-road",
            source_way_id=edge.source_way_id,
            road_class=edge.road_class,
            connector_family=connector_family_for_road_class(edge.road_class),
            bridge=edge.bridge,
            locked=True,
        )
        for edge in graph.edges
    ]
    decorated_connections = [
        RoutedConnection(
            edge_id=f"decorate-{edge.edge_id}",
            source_glyph_id=edge.source_node_ref,
            target_glyph_id=edge.target_node_ref,
            source_port_ref=edge.source_node_ref,
            target_port_ref=edge.target_node_ref,
            points=edge.points,
            hierarchy="backbone",
            is_loop=False,
            decoration=connector_family_for_road_class(edge.road_class),
            corridor_width_mm=_parameter_float(context, "route_corridor_mm"),
        )
        for edge in graph.edges
        if connector_family_for_road_class(edge.road_class) != "single"
    ]
    road_decoration = decorate_connections(
        decorated_connections,
        _parameter_float(context, "minimum_feature_mm"),
    )
    grouped: dict[str, list[DesignPath]] = {
        "glyph-structure": [],
        "glyph-detail": [],
        "glyph-accent": [],
    }
    for glyph in glyphs:
        for role_group in glyph.glyph.role_paths:
            grouped[role_group.semantic_role].extend(
                _translate_path(path, glyph.center, glyph.instance_id) for path in role_group.paths
            )
    attachment_paths = [
        _polyline_path(
            attachment.attachment_id,
            [attachment.port_point, attachment.road_point],
            hybrid_kind="road-attachment",
            road_class=attachment.road_class,
        )
        for attachment in attachments
        if attachment.distance_mm > _EPSILON
    ]
    secondary_paths = decorate_connections(
        secondary,
        _parameter_float(context, "minimum_feature_mm"),
    )
    layers = [
        DesignLayer(
            layer_id="hybrid-locked-roads",
            name="Locked map trunks",
            semantic_role="hybrid-locked-road",
            preview_color="#1f4b44",
            paths=locked_paths,
        ),
        DesignLayer(
            layer_id="hybrid-road-decoration",
            name="Road-class decoration",
            semantic_role="hybrid-road-decoration",
            preview_color="#2d7f72",
            paths=road_decoration,
        ),
        DesignLayer(
            layer_id="glyph-structure",
            name="Map glyph structures",
            semantic_role="glyph-structure",
            preview_color="#20242b",
            paths=grouped["glyph-structure"],
        ),
        DesignLayer(
            layer_id="glyph-detail",
            name="Map glyph details",
            semantic_role="glyph-detail",
            preview_color="#536878",
            paths=grouped["glyph-detail"],
        ),
        DesignLayer(
            layer_id="glyph-accent",
            name="Map landmarks",
            semantic_role="glyph-accent",
            preview_color="#c64934",
            paths=grouped["glyph-accent"],
        ),
        DesignLayer(
            layer_id="hybrid-road-attachments",
            name="Glyph road attachments",
            semantic_role="hybrid-road-attachment",
            preview_color="#136f63",
            paths=attachment_paths,
        ),
        DesignLayer(
            layer_id="hybrid-secondary-connectors",
            name="Secondary connectors",
            semantic_role="hybrid-secondary-connector",
            preview_color="#2d9c86",
            paths=secondary_paths,
        ),
        DesignLayer(
            layer_id="hybrid-junctions",
            name="Map junctions",
            semantic_role="hybrid-junction",
            preview_color="#d18f00",
            paths=[
                _junction_path(
                    junction,
                    max(0.8, _parameter_float(context, "minimum_feature_mm") * 1.2),
                )
                for junction in junctions
            ],
        ),
        DesignLayer(
            layer_id="hybrid-landscape",
            name="Landscape masks and fillers",
            semantic_role="hybrid-landscape",
            preview_color="#187a91",
            paths=_landscape_paths(landscapes),
        ),
    ]
    path_budget = _parameter_int(context, "path_budget")
    vertex_budget = _parameter_int(context, "vertex_budget")
    kept_layers: list[DesignLayer] = []
    used_paths = 0
    used_vertices = 0
    removed = 0
    for layer in layers:
        kept: list[DesignPath] = []
        for path in layer.paths:
            if used_paths + 1 > path_budget or used_vertices + len(path.commands) > vertex_budget:
                removed += 1
                continue
            kept.append(path)
            used_paths += 1
            used_vertices += len(path.commands)
        kept_layers.append(layer.model_copy(update={"paths": kept}))
    if removed:
        diagnostics.append(
            DesignDiagnostic(
                code="hybrid-budget-reduced",
                message=f"Complexity limits removed {removed} lower-priority hybrid paths.",
            )
        )
    metadata = context.recipe.osm.snapshot
    assert metadata is not None
    document = DesignDocument(
        document_id=f"{context.recipe.project_id}-map-glyphscape",
        page=context.recipe.page,
        layers=kept_layers,
        metadata=DesignMetadata(
            generator_id=HYBRID_MODE_ID,
            generator_version=HYBRID_MODE_VERSION,
            seed=context.recipe.mode.seed,
            quality=context.recipe.mode.quality,
            source_snapshot_sha256=metadata.sha256,
            source_attribution=metadata.attribution,
            source_date=metadata.source_date,
            diagnostics=diagnostics,
        ),
    )
    return document.model_copy(
        update={
            "metadata": document.metadata.model_copy(
                update={"normalized_sha256": canonical_sha256(document)}
            )
        }
    )


def generate_map_glyphscape_composition(
    snapshot: Mapping[str, Any],
    context: GenerationContext,
) -> MapGlyphscapeComposition:
    context.checkpoint("extracting locked roads", 0, 9)
    graph = build_locked_road_graph(dict(snapshot), context.recipe)
    fidelity = _parameter_float(context, "geographic_fidelity")
    graph = apply_geographic_fidelity(graph, fidelity)
    context.checkpoint("extracting landscape masks", 1, 9)
    landscapes = extract_landscape_regions(
        snapshot,
        context.recipe,
        water_behavior=cast(
            LandscapeBehavior,
            _parameter_text(context, "water_behavior"),
        ),
        park_behavior=cast(
            LandscapeBehavior,
            _parameter_text(context, "park_behavior"),
        ),
    )
    graph, blocked_water = filter_water_crossings(
        graph,
        landscapes,
        allow_crossings=_parameter_bool(context, "allow_water_crossings"),
    )
    junctions = build_road_junction_candidates(graph)
    context.checkpoint("extracting map cells", 2, 9)
    cells = extract_building_cells(snapshot, context.recipe)
    landmark_candidates = extract_landmark_candidates(snapshot, context.recipe)
    context.checkpoint("placing map glyphs", 3, 9)
    glyphs, replaced_buildings, poi_landmarks = place_map_glyphs(
        context,
        cells,
        landmark_candidates,
        landscapes,
    )
    context.checkpoint("attaching glyph ports", 4, 9)
    attachments = attach_glyph_ports_to_roads(
        glyphs,
        graph,
        maximum_distance_mm=_parameter_float(context, "road_attachment_distance_mm"),
    )
    context.checkpoint("routing secondary connectors", 5, 9)
    _, secondary, diagnostics = build_secondary_connectors(context, glyphs, landscapes)
    diagnostics = [*graph.diagnostics, *diagnostics]
    context.checkpoint("assembling hybrid layers", 7, 9)
    document = _build_document(
        context,
        graph,
        junctions,
        landscapes,
        glyphs,
        attachments,
        secondary,
        diagnostics,
    )
    all_paths = [path for layer in document.layers for path in layer.paths]
    statistics = HybridStatistics(
        locked_edge_count=len(graph.edges),
        junction_count=len(junctions),
        building_cell_count=len(cells),
        replaced_building_count=replaced_buildings,
        poi_candidate_count=len(landmark_candidates),
        poi_landmark_count=poi_landmarks,
        landscape_region_count=len(landscapes),
        attachment_count=len(attachments),
        secondary_connector_count=len(secondary),
        blocked_water_edge_count=blocked_water,
        path_count=len(all_paths),
        vertex_count=sum(len(path.commands) for path in all_paths),
        topology_sha256=graph.normalized_sha256,
        geometry_sha256=document.metadata.normalized_sha256,
    )
    context.checkpoint("complete", 9, 9)
    return MapGlyphscapeComposition(
        graph=graph,
        junctions=junctions,
        building_cells=cells,
        landmark_candidates=landmark_candidates,
        landscapes=landscapes,
        glyphs=glyphs,
        attachments=attachments,
        secondary_connections=secondary,
        statistics=statistics,
        diagnostics=diagnostics,
        document=document,
    )


def generate_map_glyphscape(
    snapshot: Mapping[str, Any],
    context: GenerationContext,
) -> DesignDocument:
    return generate_map_glyphscape_composition(snapshot, context).document
