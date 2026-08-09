from __future__ import annotations

import math
from collections import Counter
from itertools import pairwise
from typing import Any, Literal, cast

from pydantic import Field, model_validator

from plotter_core.maps.osm import (
    classify_road_role,
    clip_osm_polyline,
    create_osm_page_transform,
    project_osm_coordinate,
    simplify_osm_points,
)
from plotter_core.models import (
    DesignDiagnostic,
    Point,
    ProjectRecipe,
    StrictModel,
    canonical_sha256,
)

HYBRID_SCHEMA_VERSION: Literal[1] = 1
LOCKED_ROAD_GRAPH_VERSION = "1.0.0"
RoadClass = Literal["major", "secondary", "local", "path"]
_ENDPOINT_TOLERANCE_MM = 1e-7


class LockedRoadNode(StrictModel):
    """A stable page-space endpoint in the source-derived road graph."""

    node_id: str
    point: Point
    source_node_id: int | None = None
    boundary: bool = False


class LockedRoadEdge(StrictModel):
    """A source road span whose geometry cannot be rerouted by Glyphscape."""

    edge_id: str
    source_way_id: int
    source_node_ids: list[int] = Field(min_length=2)
    source_node_ref: str
    target_node_ref: str
    road_class: RoadClass
    highway: str
    name: str | None = None
    bridge: bool = False
    tunnel: bool = False
    one_way: bool = False
    points: list[Point] = Field(min_length=2)
    locked: Literal[True] = True

    @model_validator(mode="after")
    def geometry_is_non_degenerate(self) -> LockedRoadEdge:
        if not any(
            math.dist(
                (self.points[index - 1].x, self.points[index - 1].y),
                (self.points[index].x, self.points[index].y),
            )
            > _ENDPOINT_TOLERANCE_MM
            for index in range(1, len(self.points))
        ):
            raise ValueError("locked road edge must contain a non-degenerate span")
        return self


class LockedRoadGraph(StrictModel):
    """Versioned locked topology extracted from one frozen OSM snapshot."""

    schema_version: Literal[1] = HYBRID_SCHEMA_VERSION
    implementation_version: str = LOCKED_ROAD_GRAPH_VERSION
    snapshot_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    nodes: list[LockedRoadNode]
    edges: list[LockedRoadEdge]
    diagnostics: list[DesignDiagnostic] = Field(default_factory=list)
    normalized_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")

    @model_validator(mode="after")
    def topology_is_consistent(self) -> LockedRoadGraph:
        nodes = {node.node_id: node for node in self.nodes}
        if len(nodes) != len(self.nodes):
            raise ValueError("locked road node IDs must be unique")
        if len({edge.edge_id for edge in self.edges}) != len(self.edges):
            raise ValueError("locked road edge IDs must be unique")
        for edge in self.edges:
            source = nodes.get(edge.source_node_ref)
            target = nodes.get(edge.target_node_ref)
            if source is None or target is None:
                raise ValueError("locked road edges must reference graph nodes")
            if not _points_match(source.point, edge.points[0]):
                raise ValueError("locked road source node must match the first edge point")
            if not _points_match(target.point, edge.points[-1]):
                raise ValueError("locked road target node must match the final edge point")
        return self


class RoadJunctionCandidate(StrictModel):
    """A source-topology node eligible for a locked visual junction treatment."""

    junction_id: str
    node_ref: str
    source_node_id: int
    position: Point
    incident_edge_ids: list[str] = Field(min_length=2)
    incident_way_ids: list[int] = Field(min_length=2)
    degree: int = Field(ge=2)
    road_classes: list[RoadClass] = Field(min_length=1)
    dominant_road_class: RoadClass
    kind: Literal["merge", "tee", "cross"]
    locked: Literal[True] = True

    @model_validator(mode="after")
    def incidence_is_consistent(self) -> RoadJunctionCandidate:
        if self.degree != len(self.incident_edge_ids):
            raise ValueError("junction degree must equal its incident edge count")
        if len(set(self.incident_way_ids)) != len(self.incident_way_ids):
            raise ValueError("junction incident way IDs must be unique")
        if self.dominant_road_class not in self.road_classes:
            raise ValueError("dominant road class must be incident at the junction")
        expected_kind = "merge" if self.degree == 2 else "tee" if self.degree == 3 else "cross"
        if self.kind != expected_kind:
            raise ValueError("junction kind must match its graph degree")
        return self


def _points_match(first: Point, second: Point) -> bool:
    return math.dist((first.x, first.y), (second.x, second.y)) <= _ENDPOINT_TOLERANCE_MM


def _tag_enabled(tags: dict[str, Any], key: str) -> bool:
    value = tags.get(key)
    return isinstance(value, str) and value.lower() not in {"", "no", "false", "0"}


def _road_class(highway: str) -> RoadClass:
    role = classify_road_role(highway)
    return cast(
        RoadClass,
        {
            "road-major": "major",
            "road-secondary": "secondary",
            "road-local": "local",
            "road-path": "path",
        }[role],
    )


def _source_endpoint(
    *,
    point: Point,
    expected: Point,
    source_node_id: int,
    boundary_id: str,
) -> LockedRoadNode:
    if _points_match(point, expected):
        return LockedRoadNode(
            node_id=f"osm-node-{source_node_id}",
            point=point,
            source_node_id=source_node_id,
        )
    return LockedRoadNode(node_id=boundary_id, point=point, boundary=True)


def build_locked_road_graph(
    snapshot: dict[str, Any],
    recipe: ProjectRecipe,
) -> LockedRoadGraph:
    """Convert frozen OSM highways into deterministic, clipped, locked graph edges."""

    metadata = recipe.osm.snapshot
    if metadata is None:
        raise ValueError("fetch and freeze an OSM snapshot before building locked roads")
    if not recipe.osm.features.roads:
        graph = LockedRoadGraph(
            snapshot_sha256=metadata.sha256,
            nodes=[],
            edges=[],
            diagnostics=[
                DesignDiagnostic(
                    code="hybrid-roads-disabled",
                    message="Road extraction is disabled by the map feature settings.",
                )
            ],
            normalized_sha256="0" * 64,
        )
        return graph.model_copy(
            update={
                "normalized_sha256": canonical_sha256(
                    graph.model_dump(exclude={"normalized_sha256"})
                )
            }
        )

    elements = snapshot.get("elements")
    if not isinstance(elements, list):
        raise ValueError("OSM snapshot must contain an elements list")
    bounds = metadata.bounds
    transform = create_osm_page_transform(bounds, recipe)
    metric_nodes: dict[int, tuple[float, float]] = {}
    for element in elements:
        if (
            isinstance(element, dict)
            and element.get("type") == "node"
            and isinstance(element.get("id"), int)
            and isinstance(element.get("lat"), int | float)
            and isinstance(element.get("lon"), int | float)
        ):
            metric_nodes[element["id"]] = project_osm_coordinate(
                element["lat"], element["lon"], bounds
            )

    road_ways: list[tuple[int, list[int], dict[str, Any]]] = []
    ignored = 0
    for element in elements:
        if not isinstance(element, dict) or element.get("type") != "way":
            continue
        tags = element.get("tags")
        refs = element.get("nodes")
        way_id = element.get("id")
        if (
            not isinstance(tags, dict)
            or not isinstance(tags.get("highway"), str)
            or not isinstance(refs, list)
            or not isinstance(way_id, int)
        ):
            continue
        valid_refs = [ref for ref in refs if isinstance(ref, int) and ref in metric_nodes]
        if len(valid_refs) < 2:
            ignored += 1
            continue
        road_ways.append((way_id, valid_refs, tags))
    road_ways.sort(key=lambda item: item[0])

    usage: Counter[int] = Counter()
    for _, refs, _ in road_ways:
        usage.update(set(refs))

    rectangle = (
        recipe.page.safe_min.x,
        recipe.page.safe_min.y,
        recipe.page.safe_max.x,
        recipe.page.safe_max.y,
    )
    nodes_by_id: dict[str, LockedRoadNode] = {}
    edges: list[LockedRoadEdge] = []
    clipped_away = 0
    for way_id, refs, tags in road_ways:
        split_indices = sorted(
            {0, len(refs) - 1}
            | {index for index, ref in enumerate(refs[1:-1], start=1) if usage[ref] > 1}
        )
        for span_index, (start_index, end_index) in enumerate(pairwise(split_indices)):
            span_refs = refs[start_index : end_index + 1]
            transformed = [
                Point(x=point[0], y=point[1])
                for point in (
                    transform(metric_nodes[source_node_id]) for source_node_id in span_refs
                )
            ]
            simplified = simplify_osm_points(
                [(point.x, point.y) for point in transformed],
                recipe.osm.render.simplification_tolerance_mm,
            )
            groups = clip_osm_polyline(simplified, rectangle)
            if not groups:
                clipped_away += 1
                continue
            for group_index, group in enumerate(groups):
                points = [Point(x=x, y=y) for x, y in group]
                if (
                    sum(
                        math.dist(
                            (points[index - 1].x, points[index - 1].y),
                            (points[index].x, points[index].y),
                        )
                        for index in range(1, len(points))
                    )
                    < recipe.osm.render.minimum_feature_mm
                ):
                    clipped_away += 1
                    continue
                edge_id = f"osm-road-{way_id}-{span_index}-{group_index}"
                source = _source_endpoint(
                    point=points[0],
                    expected=transformed[0],
                    source_node_id=span_refs[0],
                    boundary_id=f"{edge_id}-boundary-start",
                )
                target = _source_endpoint(
                    point=points[-1],
                    expected=transformed[-1],
                    source_node_id=span_refs[-1],
                    boundary_id=f"{edge_id}-boundary-end",
                )
                nodes_by_id.setdefault(source.node_id, source)
                nodes_by_id.setdefault(target.node_id, target)
                highway = tags["highway"]
                name = tags.get("name")
                edges.append(
                    LockedRoadEdge(
                        edge_id=edge_id,
                        source_way_id=way_id,
                        source_node_ids=span_refs,
                        source_node_ref=source.node_id,
                        target_node_ref=target.node_id,
                        road_class=_road_class(highway),
                        highway=highway,
                        name=name if isinstance(name, str) else None,
                        bridge=_tag_enabled(tags, "bridge"),
                        tunnel=_tag_enabled(tags, "tunnel"),
                        one_way=_tag_enabled(tags, "oneway"),
                        points=points,
                    )
                )

    diagnostics: list[DesignDiagnostic] = []
    if ignored:
        diagnostics.append(
            DesignDiagnostic(
                code="hybrid-roads-incomplete",
                message=f"{ignored} incomplete OSM road ways were not converted.",
            )
        )
    if clipped_away:
        diagnostics.append(
            DesignDiagnostic(
                code="hybrid-roads-clipped",
                message=(
                    f"{clipped_away} road spans were outside the page or below the minimum size."
                ),
            )
        )
    graph = LockedRoadGraph(
        snapshot_sha256=metadata.sha256,
        nodes=sorted(nodes_by_id.values(), key=lambda item: item.node_id),
        edges=sorted(edges, key=lambda item: item.edge_id),
        diagnostics=diagnostics,
        normalized_sha256="0" * 64,
    )
    return graph.model_copy(
        update={
            "normalized_sha256": canonical_sha256(graph.model_dump(exclude={"normalized_sha256"}))
        }
    )


def build_road_junction_candidates(
    graph: LockedRoadGraph,
) -> list[RoadJunctionCandidate]:
    """Map shared OSM road nodes to deterministic locked junction candidates."""

    nodes = {node.node_id: node for node in graph.nodes}
    incident: dict[str, list[LockedRoadEdge]] = {}
    for edge in graph.edges:
        incident.setdefault(edge.source_node_ref, []).append(edge)
        incident.setdefault(edge.target_node_ref, []).append(edge)

    class_priority: dict[RoadClass, int] = {
        "major": 0,
        "secondary": 1,
        "local": 2,
        "path": 3,
    }
    candidates: list[RoadJunctionCandidate] = []
    for node_ref, edges in sorted(incident.items()):
        node = nodes[node_ref]
        way_ids = sorted({edge.source_way_id for edge in edges})
        if node.source_node_id is None or len(way_ids) < 2:
            continue
        ordered_edges = sorted(edges, key=lambda edge: edge.edge_id)
        road_classes = sorted(
            {edge.road_class for edge in edges},
            key=lambda road_class: (class_priority[road_class], road_class),
        )
        degree = len(ordered_edges)
        candidates.append(
            RoadJunctionCandidate(
                junction_id=f"osm-junction-{node.source_node_id}",
                node_ref=node_ref,
                source_node_id=node.source_node_id,
                position=node.point,
                incident_edge_ids=[edge.edge_id for edge in ordered_edges],
                incident_way_ids=way_ids,
                degree=degree,
                road_classes=road_classes,
                dominant_road_class=road_classes[0],
                kind="merge" if degree == 2 else "tee" if degree == 3 else "cross",
            )
        )
    return candidates
