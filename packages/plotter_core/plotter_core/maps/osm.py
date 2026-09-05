from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Callable
from itertools import pairwise
from typing import Any

from plotter_core.models import (
    CloseCommand,
    DesignDiagnostic,
    DesignDocument,
    DesignLayer,
    DesignMetadata,
    DesignPath,
    LineCommand,
    MoveCommand,
    OsmBounds,
    Point,
    ProjectRecipe,
    canonical_sha256,
)

EARTH_RADIUS_M = 6_371_008.8
MAX_QUERY_AREA_KM2 = 100.0
OSM_GENERATOR_ID = "map.openstreetmap"
OSM_GENERATOR_VERSION = "1.0.0"

ProgressCallback = Callable[[str, int | None, int | None], None]

ROLE_STYLE = {
    "road-major": ("Major roads", "#20241f"),
    "road-secondary": ("Secondary roads", "#4b5148"),
    "road-local": ("Local roads", "#777b70"),
    "road-path": ("Paths and cycleways", "#9b8669"),
    "rail": ("Rail", "#9c3f2c"),
    "water": ("Water", "#187a91"),
    "buildings": ("Buildings", "#6c5546"),
    "parks": ("Parks and land use", "#58723e"),
}


def selection_area_km2(bounds: OsmBounds) -> float:
    latitude_m = math.radians(bounds.north - bounds.south) * EARTH_RADIUS_M
    center_latitude = math.radians((bounds.south + bounds.north) / 2)
    longitude_m = (
        math.radians(bounds.east - bounds.west) * EARTH_RADIUS_M * math.cos(center_latitude)
    )
    return abs(latitude_m * longitude_m) / 1_000_000


def build_overpass_query(bounds: OsmBounds) -> str:
    area = selection_area_km2(bounds)
    if area > MAX_QUERY_AREA_KM2:
        raise ValueError(
            f"OSM selection is {area:.2f} km²; maximum request area is {MAX_QUERY_AREA_KM2:.0f} km²"
        )
    bbox = f"{bounds.south:.7f},{bounds.west:.7f},{bounds.north:.7f},{bounds.east:.7f}"
    return (
        "[out:json][timeout:90];("
        f'way["highway"]({bbox});'
        f'way["building"]({bbox});'
        f'way["natural"="water"]({bbox});'
        f'way["waterway"]({bbox});'
        f'way["railway"]({bbox});'
        f'way["leisure"="park"]({bbox});'
        f'way["landuse"]({bbox});'
        f'node["amenity"]({bbox});'
        f'node["tourism"]({bbox});'
        f'node["historic"]({bbox});'
        ");out body;>;out skel qt;"
    )


def project_osm_coordinate(
    latitude: float, longitude: float, bounds: OsmBounds
) -> tuple[float, float]:
    center_latitude = math.radians((bounds.south + bounds.north) / 2)
    center_longitude = math.radians((bounds.west + bounds.east) / 2)
    x = EARTH_RADIUS_M * (math.radians(longitude) - center_longitude) * math.cos(center_latitude)
    y = EARTH_RADIUS_M * (math.radians(latitude) - math.radians((bounds.south + bounds.north) / 2))
    return x, y


def classify_road_role(highway: str) -> str:
    if highway in {"motorway", "motorway_link", "trunk", "trunk_link", "primary"}:
        return "road-major"
    if highway in {"secondary", "secondary_link", "tertiary", "tertiary_link"}:
        return "road-secondary"
    if highway in {"footway", "cycleway", "path", "pedestrian", "steps", "bridleway"}:
        return "road-path"
    return "road-local"


def _feature_role(tags: dict[str, str]) -> str | None:
    if "highway" in tags:
        return classify_road_role(tags["highway"])
    if "building" in tags:
        return "buildings"
    if tags.get("natural") in {"water", "bay"} or tags.get("waterway") == "riverbank":
        return "water"
    if "waterway" in tags:
        return "water"
    if "railway" in tags and tags["railway"] not in {"abandoned", "razed"}:
        return "rail"
    if tags.get("leisure") in {"park", "garden", "nature_reserve"}:
        return "parks"
    if tags.get("landuse") in {
        "forest",
        "grass",
        "meadow",
        "recreation_ground",
        "village_green",
    }:
        return "parks"
    if tags.get("natural") in {"wood", "grassland", "scrub"}:
        return "parks"
    return None


def _rotate(point: tuple[float, float], angle_radians: float) -> tuple[float, float]:
    cosine = math.cos(angle_radians)
    sine = math.sin(angle_radians)
    return point[0] * cosine - point[1] * sine, point[0] * sine + point[1] * cosine


def create_osm_page_transform(
    bounds: OsmBounds,
    recipe: ProjectRecipe,
) -> Callable[[tuple[float, float]], tuple[float, float]]:
    corners = [
        project_osm_coordinate(bounds.south, bounds.west, bounds),
        project_osm_coordinate(bounds.south, bounds.east, bounds),
        project_osm_coordinate(bounds.north, bounds.east, bounds),
        project_osm_coordinate(bounds.north, bounds.west, bounds),
    ]
    angle = math.radians(recipe.osm.selection.rotation_degrees)
    rotated = [_rotate(point, angle) for point in corners]
    min_x = min(point[0] for point in rotated)
    max_x = max(point[0] for point in rotated)
    min_y = min(point[1] for point in rotated)
    max_y = max(point[1] for point in rotated)
    safe_width = recipe.page.safe_max.x - recipe.page.safe_min.x
    safe_height = recipe.page.safe_max.y - recipe.page.safe_min.y
    scale = min(safe_width / (max_x - min_x), safe_height / (max_y - min_y))
    offset_x = recipe.page.safe_min.x + (safe_width - (max_x - min_x) * scale) / 2
    offset_y = recipe.page.safe_min.y + (safe_height - (max_y - min_y) * scale) / 2

    def transform(point: tuple[float, float]) -> tuple[float, float]:
        x, y = _rotate(point, angle)
        return (offset_x + (x - min_x) * scale, offset_y + (y - min_y) * scale)

    return transform


def simplify_osm_points(
    points: list[tuple[float, float]], tolerance: float
) -> list[tuple[float, float]]:
    if tolerance <= 0 or len(points) <= 2:
        return points
    start = points[0]
    end = points[-1]
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    denominator = math.hypot(dx, dy)
    farthest_index = 0
    farthest_distance = 0.0
    for index, point in enumerate(points[1:-1], start=1):
        if denominator == 0:
            distance = math.dist(start, point)
        else:
            distance = abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0])
            distance /= denominator
        if distance > farthest_distance:
            farthest_index = index
            farthest_distance = distance
    if farthest_distance <= tolerance:
        return [start, end]
    return [
        *simplify_osm_points(points[: farthest_index + 1], tolerance)[:-1],
        *simplify_osm_points(points[farthest_index:], tolerance),
    ]


def _clip_segment(
    first: tuple[float, float],
    second: tuple[float, float],
    rectangle: tuple[float, float, float, float],
) -> tuple[tuple[float, float], tuple[float, float]] | None:
    min_x, min_y, max_x, max_y = rectangle
    dx = second[0] - first[0]
    dy = second[1] - first[1]
    lower = 0.0
    upper = 1.0
    for direction, distance in (
        (-dx, first[0] - min_x),
        (dx, max_x - first[0]),
        (-dy, first[1] - min_y),
        (dy, max_y - first[1]),
    ):
        if direction == 0:
            if distance < 0:
                return None
            continue
        ratio = distance / direction
        if direction < 0:
            lower = max(lower, ratio)
        else:
            upper = min(upper, ratio)
        if lower > upper:
            return None
    return (
        (first[0] + lower * dx, first[1] + lower * dy),
        (first[0] + upper * dx, first[1] + upper * dy),
    )


def clip_osm_polyline(
    points: list[tuple[float, float]],
    rectangle: tuple[float, float, float, float],
) -> list[list[tuple[float, float]]]:
    groups: list[list[tuple[float, float]]] = []
    for first, second in pairwise(points):
        clipped = _clip_segment(first, second, rectangle)
        if clipped is None:
            continue
        if groups and math.dist(groups[-1][-1], clipped[0]) < 1e-8:
            groups[-1].append(clipped[1])
        else:
            groups.append([clipped[0], clipped[1]])
    return groups


def clip_osm_polygon(
    points: list[tuple[float, float]],
    rectangle: tuple[float, float, float, float],
) -> list[tuple[float, float]]:
    polygon = points[:-1] if points and points[0] == points[-1] else points
    min_x, min_y, max_x, max_y = rectangle

    def clip_edge(
        vertices: list[tuple[float, float]],
        inside: Callable[[tuple[float, float]], bool],
        intersect: Callable[[tuple[float, float], tuple[float, float]], tuple[float, float]],
    ) -> list[tuple[float, float]]:
        if not vertices:
            return []
        output: list[tuple[float, float]] = []
        previous = vertices[-1]
        previous_inside = inside(previous)
        for current in vertices:
            current_inside = inside(current)
            if current_inside:
                if not previous_inside:
                    output.append(intersect(previous, current))
                output.append(current)
            elif previous_inside:
                output.append(intersect(previous, current))
            previous = current
            previous_inside = current_inside
        return output

    def vertical(
        x: float,
    ) -> Callable[[tuple[float, float], tuple[float, float]], tuple[float, float]]:
        return lambda a, b: (
            x,
            a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]),
        )

    def horizontal(
        y: float,
    ) -> Callable[[tuple[float, float], tuple[float, float]], tuple[float, float]]:
        return lambda a, b: (
            a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]),
            y,
        )

    polygon = clip_edge(polygon, lambda point: point[0] >= min_x, vertical(min_x))
    polygon = clip_edge(polygon, lambda point: point[0] <= max_x, vertical(max_x))
    polygon = clip_edge(polygon, lambda point: point[1] >= min_y, horizontal(min_y))
    polygon = clip_edge(polygon, lambda point: point[1] <= max_y, horizontal(max_y))
    return [*polygon, polygon[0]] if len(polygon) >= 3 else []


def _polyline_path(path_id: str, points: list[tuple[float, float]], **metadata: Any) -> DesignPath:
    commands: list[MoveCommand | LineCommand | CloseCommand] = [
        MoveCommand(point=Point(x=points[0][0], y=points[0][1]))
    ]
    commands.extend(LineCommand(point=Point(x=x, y=y)) for x, y in points[1:])
    closed = len(points) > 2 and points[0] == points[-1]
    if closed:
        commands.append(CloseCommand())
    return DesignPath(
        path_id=path_id,
        commands=commands,
        closed=closed,
        metadata={
            key: value
            for key, value in metadata.items()
            if isinstance(value, str | int | float | bool)
        },
    )


def _offset_polyline(points: list[tuple[float, float]], offset: float) -> list[tuple[float, float]]:
    if len(points) < 2:
        return points
    normals: list[tuple[float, float]] = []
    for first, second in pairwise(points):
        dx = second[0] - first[0]
        dy = second[1] - first[1]
        length = math.hypot(dx, dy) or 1
        normals.append((-dy / length, dx / length))
    output: list[tuple[float, float]] = []
    for index, point in enumerate(points):
        if index == 0:
            normal = normals[0]
        elif index == len(points) - 1:
            normal = normals[-1]
        else:
            nx = normals[index - 1][0] + normals[index][0]
            ny = normals[index - 1][1] + normals[index][1]
            length = math.hypot(nx, ny) or 1
            normal = (nx / length, ny / length)
        output.append((point[0] + normal[0] * offset, point[1] + normal[1] * offset))
    return output


def _hatch_polygon(
    polygon: list[tuple[float, float]],
    *,
    spacing: float,
    angle_degrees: float,
) -> list[list[tuple[float, float]]]:
    if len(polygon) < 4:
        return []
    angle = math.radians(angle_degrees)
    rotated = [_rotate(point, -angle) for point in polygon]
    min_y = min(point[1] for point in rotated)
    max_y = max(point[1] for point in rotated)
    lines: list[list[tuple[float, float]]] = []
    y = math.floor(min_y / spacing) * spacing
    while y <= max_y + 1e-9:
        intersections: list[float] = []
        for first, second in pairwise(rotated):
            if (first[1] <= y < second[1]) or (second[1] <= y < first[1]):
                fraction = (y - first[1]) / (second[1] - first[1])
                intersections.append(first[0] + fraction * (second[0] - first[0]))
        intersections.sort()
        for left, right in zip(intersections[::2], intersections[1::2], strict=False):
            lines.append([_rotate((left, y), angle), _rotate((right, y), angle)])
        y += spacing
    return lines


def generate_osm_design(
    snapshot: dict[str, Any],
    recipe: ProjectRecipe,
    *,
    progress: ProgressCallback | None = None,
) -> DesignDocument:
    metadata = recipe.osm.snapshot
    if metadata is None:
        raise ValueError("fetch and freeze an OSM snapshot before generating map artwork")
    bounds = metadata.bounds
    transform = create_osm_page_transform(bounds, recipe)
    elements = snapshot.get("elements")
    if not isinstance(elements, list):
        raise ValueError("OSM snapshot must contain an elements list")
    nodes: dict[int, tuple[float, float]] = {}
    for element in elements:
        if (
            isinstance(element, dict)
            and element.get("type") == "node"
            and isinstance(element.get("id"), int)
            and isinstance(element.get("lat"), int | float)
            and isinstance(element.get("lon"), int | float)
        ):
            nodes[element["id"]] = project_osm_coordinate(element["lat"], element["lon"], bounds)

    paths_by_role: dict[str, list[DesignPath]] = defaultdict(list)
    ignored = 0
    ways = [item for item in elements if isinstance(item, dict) and item.get("type") == "way"]
    total = len(ways)
    if progress is not None:
        progress("classify-osm", 0, total)
    for index, way in enumerate(ways):
        tags = way.get("tags", {})
        role = _feature_role(tags) if isinstance(tags, dict) else None
        refs = way.get("nodes")
        if role is None or not isinstance(refs, list):
            ignored += 1
            continue
        if role.startswith("road") and not recipe.osm.features.roads:
            continue
        if role == "buildings" and not recipe.osm.features.buildings:
            continue
        if role == "water" and not recipe.osm.features.water:
            continue
        if role == "rail" and not recipe.osm.features.rail:
            continue
        if role == "parks" and not recipe.osm.features.parks:
            continue
        metric = [
            nodes[node_id] for node_id in refs if isinstance(node_id, int) and node_id in nodes
        ]
        if len(metric) < 2:
            ignored += 1
            continue
        points = simplify_osm_points(
            [transform(point) for point in metric],
            recipe.osm.render.simplification_tolerance_mm,
        )
        rectangle = (
            recipe.page.safe_min.x,
            recipe.page.safe_min.y,
            recipe.page.safe_max.x,
            recipe.page.safe_max.y,
        )
        closed_polygon = len(points) > 3 and refs[0] == refs[-1]
        if closed_polygon:
            clipped_polygon = clip_osm_polygon(points, rectangle)
            point_groups = [clipped_polygon] if clipped_polygon else []
        else:
            point_groups = clip_osm_polyline(points, rectangle)
        way_id = way.get("id", index)
        for group_index, group in enumerate(point_groups):
            length = sum(math.dist(first, second) for first, second in pairwise(group))
            if length < recipe.osm.render.minimum_feature_mm:
                continue
            base_id = f"osm-{way_id}-{group_index}"
            paths_by_role[role].append(
                _polyline_path(
                    base_id,
                    group,
                    osm_id=int(way_id) if isinstance(way_id, int) else index,
                    feature_class=role,
                )
            )

            if role.startswith("road") and recipe.osm.render.road_line_treatment != "centerline":
                half_width = recipe.osm.render.road_width_mm / 2
                paths_by_role[role].pop()
                for side, offset in (("left", -half_width), ("right", half_width)):
                    offset_points = clip_osm_polyline(
                        _offset_polyline(group, offset),
                        rectangle,
                    )
                    for offset_index, offset_group in enumerate(offset_points):
                        paths_by_role[role].append(
                            _polyline_path(
                                f"{base_id}-{side}-{offset_index}",
                                offset_group,
                                osm_id=int(way_id) if isinstance(way_id, int) else index,
                                feature_class=role,
                                line_treatment=recipe.osm.render.road_line_treatment,
                            )
                        )

            treatment = (
                recipe.osm.render.building_treatment
                if role == "buildings"
                else recipe.osm.render.water_treatment
                if role == "water"
                else recipe.osm.render.park_treatment
                if role == "parks"
                else "outline"
            )
            if closed_polygon and treatment == "hatch":
                for hatch_index, hatch in enumerate(
                    _hatch_polygon(
                        group,
                        spacing=recipe.osm.render.polygon_hatch_spacing_mm,
                        angle_degrees=recipe.osm.render.polygon_hatch_angle_degrees,
                    )
                ):
                    paths_by_role[role].append(
                        _polyline_path(
                            f"{base_id}-hatch-{hatch_index}",
                            hatch,
                            treatment="hatch",
                        )
                    )
        if progress is not None and (index % 25 == 0 or index + 1 == total):
            progress("classify-osm", index + 1, total)

    diagnostics = [
        DesignDiagnostic(
            code="osm-attribution",
            message=f"{metadata.attribution}; snapshot {metadata.source_date}",
        )
    ]
    if ignored:
        diagnostics.append(
            DesignDiagnostic(
                code="osm-features-ignored",
                message=f"{ignored} unsupported or incomplete OSM ways were not rendered",
            )
        )
    layers = [
        DesignLayer(
            layer_id=f"layer-{role}",
            name=ROLE_STYLE[role][0],
            semantic_role=role,
            preview_color=ROLE_STYLE[role][1],
            paths=paths,
            metadata={"snapshot_sha256": metadata.sha256},
        )
        for role, paths in sorted(paths_by_role.items())
        if paths
    ]
    document = DesignDocument(
        document_id=f"osm-{metadata.sha256[:16]}",
        page=recipe.page,
        layers=layers,
        metadata=DesignMetadata(
            generator_id=OSM_GENERATOR_ID,
            generator_version=OSM_GENERATOR_VERSION,
            seed=recipe.mode.seed,
            quality=recipe.mode.quality,
            source_snapshot_sha256=metadata.sha256,
            source_attribution=metadata.attribution,
            source_date=metadata.source_date,
            diagnostics=diagnostics,
        ),
    )
    digest = canonical_sha256(document)
    return document.model_copy(
        update={"metadata": document.metadata.model_copy(update={"normalized_sha256": digest})}
    )
