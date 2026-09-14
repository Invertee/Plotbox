from __future__ import annotations

import math
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from itertools import pairwise
from typing import Any, Literal

from plotter_core.maps.terrain import (
    AwsTerrariumTerrainProvider,
    TerrainProvider,
    generate_contours,
)
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
OSM_GENERATOR_VERSION = "2.0.0"

ProgressCallback = Callable[[str, int | None, int | None], None]
CancelCallback = Callable[[], None]

ROLE_STYLE: dict[str, tuple[str, str]] = {
    "road-major": ("Major roads", "#20241f"),
    "road-secondary": ("Secondary roads", "#4b5148"),
    "road-local": ("Residential roads", "#777b70"),
    "road-path": ("Paths, cycleways and tracks", "#9b8669"),
    "rail": ("Rail", "#9c3f2c"),
    "water": ("Water areas", "#187a91"),
    "waterway": ("Waterways", "#277f96"),
    "coastline": ("Coastline", "#17697d"),
    "buildings": ("Buildings", "#6c5546"),
    "parks": ("Parks", "#58723e"),
    "forest": ("Woodland and forest", "#4f6d3d"),
    "farmland": ("Farmland", "#8a7b43"),
    "meadow": ("Meadow and grass", "#779056"),
    "landuse-residential": ("Residential landuse", "#81756d"),
    "landuse-industrial": ("Industrial landuse", "#756a65"),
    "cemetery": ("Cemeteries", "#68725a"),
    "parking": ("Parking", "#7f7f76"),
    "wetland": ("Wetlands", "#4f7772"),
    "boundary": ("Administrative boundaries", "#6f647d"),
    "power-line": ("Power lines", "#676767"),
    "power-node": ("Power towers and poles", "#676767"),
    "aeroway-runway": ("Runways", "#555a5e"),
    "aeroway-taxiway": ("Taxiways", "#74787b"),
    "maritime": ("Piers and sea defences", "#55666d"),
    "poi-worship": ("Places of worship", "#675f55"),
    "poi-station": ("Railway stations", "#8a3e30"),
    "poi-peak": ("Peaks", "#5f5b50"),
    "poi-historic": ("Historic sites", "#76553e"),
    "poi-castle": ("Castles and ruins", "#6b4b3b"),
    "poi-lighthouse": ("Lighthouses", "#436a76"),
    "poi-wind-turbine": ("Wind turbines", "#5c6b70"),
    "poi-school": ("Schools", "#6d6752"),
    "poi-hospital": ("Hospitals", "#934844"),
    "poi-tree": ("Trees", "#4e6c45"),
    "poi-monument": ("Monuments", "#715f4c"),
    "terrain-contour": ("Terrain contours", "#7b6b55"),
    "terrain-index-contour": ("Index contours", "#57493a"),
}

ROAD_ROLE_BY_HIGHWAY: dict[str, str] = {
    "motorway": "road-major",
    "motorway_link": "road-major",
    "trunk": "road-major",
    "trunk_link": "road-major",
    "primary": "road-major",
    "primary_link": "road-major",
    "secondary": "road-secondary",
    "secondary_link": "road-secondary",
    "tertiary": "road-secondary",
    "tertiary_link": "road-secondary",
    "residential": "road-local",
    "living_street": "road-local",
    "unclassified": "road-local",
    "service": "road-local",
    "footway": "road-path",
    "path": "road-path",
    "steps": "road-path",
    "bridleway": "road-path",
    "pedestrian": "road-path",
    "cycleway": "road-path",
    "track": "road-path",
}

HIGHWAY_TOGGLE = {
    "motorway": "road_motorways",
    "motorway_link": "road_motorways",
    "trunk": "road_motorways",
    "trunk_link": "road_motorways",
    "primary": "road_primary",
    "primary_link": "road_primary",
    "secondary": "road_secondary",
    "secondary_link": "road_secondary",
    "tertiary": "road_secondary",
    "tertiary_link": "road_secondary",
    "residential": "road_residential",
    "living_street": "road_residential",
    "unclassified": "road_residential",
    "service": "road_service",
    "footway": "footpaths",
    "path": "footpaths",
    "steps": "footpaths",
    "bridleway": "footpaths",
    "pedestrian": "pedestrian_paths",
    "cycleway": "cycleways",
    "track": "tracks",
}


ROAD_CLASSIFIED_TREATMENTS: dict[str, str] = {
    "road-major": "casing",
    "road-secondary": "centerline",
    "road-local": "centerline",
    "road-path": "dashed",
}

# Code-level defaults keep landuse categories visually distinct without adding a large UI matrix.
LANDUSE_HATCH_OVERRIDES: dict[str, tuple[float, float]] = {
    "forest": (45.0, 0.8),
    "farmland": (-25.0, 1.25),
    "meadow": (20.0, 1.1),
    "landuse-residential": (0.0, 1.4),
    "landuse-industrial": (90.0, 1.0),
    "cemetery": (45.0, 1.0),
    "parking": (0.0, 1.6),
    "wetland": (-45.0, 0.9),
}

RAIL_SUPPORTED = {"rail", "light_rail", "tram", "subway", "narrow_gauge"}


@dataclass(frozen=True)
class FeatureDefinition:
    role: str
    toggle: str
    geometry: Literal["line", "polygon"]
    matches: Callable[[dict[str, str]], bool]


FEATURE_DEFINITIONS: tuple[FeatureDefinition, ...] = (
    FeatureDefinition("buildings", "buildings", "polygon", lambda tags: "building" in tags),
    FeatureDefinition(
        "water",
        "water_areas",
        "polygon",
        lambda tags: tags.get("natural") in {"water", "bay"}
        or tags.get("water") in {"lake", "reservoir", "pond", "basin"}
        or tags.get("landuse") in {"reservoir", "basin"}
        or tags.get("waterway") == "riverbank",
    ),
    FeatureDefinition(
        "waterway",
        "waterways",
        "line",
        lambda tags: tags.get("waterway") in {"river", "stream", "canal", "drain", "ditch"},
    ),
    FeatureDefinition(
        "coastline", "coastline", "line", lambda tags: tags.get("natural") == "coastline"
    ),
    FeatureDefinition(
        "rail", "rail", "line", lambda tags: tags.get("railway") in RAIL_SUPPORTED
    ),
    FeatureDefinition(
        "parks",
        "parks",
        "polygon",
        lambda tags: tags.get("leisure") in {"park", "garden", "nature_reserve"}
        or tags.get("landuse") in {"recreation_ground", "village_green"},
    ),
    FeatureDefinition(
        "forest",
        "woodland",
        "polygon",
        lambda tags: tags.get("landuse") == "forest" or tags.get("natural") == "wood",
    ),
    FeatureDefinition(
        "farmland", "farmland", "polygon", lambda tags: tags.get("landuse") == "farmland"
    ),
    FeatureDefinition(
        "meadow",
        "meadow",
        "polygon",
        lambda tags: tags.get("landuse") in {"meadow", "grass"}
        or tags.get("natural") in {"grassland", "scrub"},
    ),
    FeatureDefinition(
        "landuse-residential",
        "residential_landuse",
        "polygon",
        lambda tags: tags.get("landuse") == "residential",
    ),
    FeatureDefinition(
        "landuse-industrial",
        "industrial_landuse",
        "polygon",
        lambda tags: tags.get("landuse") in {"industrial", "commercial", "retail"},
    ),
    FeatureDefinition(
        "cemetery",
        "cemetery",
        "polygon",
        lambda tags: tags.get("landuse") == "cemetery" or tags.get("amenity") == "grave_yard",
    ),
    FeatureDefinition(
        "parking", "parking", "polygon", lambda tags: tags.get("amenity") == "parking"
    ),
    FeatureDefinition(
        "wetland", "wetlands", "polygon", lambda tags: tags.get("natural") == "wetland"
    ),
    FeatureDefinition(
        "boundary",
        "boundaries",
        "line",
        lambda tags: tags.get("boundary") == "administrative",
    ),
    FeatureDefinition(
        "power-line",
        "power_lines",
        "line",
        lambda tags: tags.get("power") in {"line", "minor_line"},
    ),
    FeatureDefinition(
        "aeroway-runway",
        "aeroway",
        "line",
        lambda tags: tags.get("aeroway") == "runway",
    ),
    FeatureDefinition(
        "aeroway-taxiway",
        "aeroway",
        "line",
        lambda tags: tags.get("aeroway") == "taxiway",
    ),
    FeatureDefinition(
        "maritime",
        "maritime",
        "line",
        lambda tags: tags.get("man_made") in {"pier", "breakwater", "seawall"},
    ),
)

POI_MATCHERS: tuple[tuple[str, str, Callable[[dict[str, str]], bool]], ...] = (
    ("poi-worship", "poi_worship", lambda tags: tags.get("amenity") == "place_of_worship"),
    ("poi-station", "poi_stations", lambda tags: tags.get("railway") in {"station", "halt"}),
    ("poi-peak", "poi_peaks", lambda tags: tags.get("natural") == "peak"),
    ("poi-castle", "poi_castles", lambda tags: tags.get("historic") in {"castle", "ruins"}),
    (
        "poi-monument",
        "poi_monuments",
        lambda tags: tags.get("historic") in {"monument", "memorial"},
    ),
    ("poi-historic", "poi_historic", lambda tags: "historic" in tags),
    ("poi-lighthouse", "poi_lighthouses", lambda tags: tags.get("man_made") == "lighthouse"),
    (
        "poi-wind-turbine",
        "poi_wind_turbines",
        lambda tags: tags.get("power") == "generator" and tags.get("generator:source") == "wind",
    ),
    ("poi-school", "poi_schools", lambda tags: tags.get("amenity") == "school"),
    ("poi-hospital", "poi_hospitals", lambda tags: tags.get("amenity") == "hospital"),
    ("poi-tree", "poi_trees", lambda tags: tags.get("natural") == "tree"),
)


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
    way_filters = (
        'way["highway"]',
        'way["building"]',
        'way["natural"~"^(water|bay|coastline|wood|grassland|scrub|wetland)$"]',
        'way["water"~"^(lake|reservoir|pond|basin)$"]',
        'way["waterway"~"^(river|stream|canal|drain|ditch|riverbank)$"]',
        'way["railway"~"^(rail|light_rail|tram|subway|narrow_gauge)$"]',
        'way["leisure"~"^(park|garden|nature_reserve)$"]',
        'way["landuse"~"^(forest|farmland|meadow|grass|residential|industrial|commercial|retail|'
        'cemetery|recreation_ground|village_green|reservoir|basin)$"]',
        'way["amenity"~"^(parking|grave_yard|place_of_worship|school|hospital)$"]',
        'way["historic"]',
        'way["railway"~"^(station|halt)$"]',
        'way["power"="generator"]["generator:source"="wind"]',
        'way["boundary"="administrative"]',
        'relation["boundary"="administrative"]',
        'way["power"]',
        'way["aeroway"]',
        'way["man_made"]',
    )
    node_filters = (
        'node["amenity"]',
        'node["railway"]',
        'node["natural"]',
        'node["historic"]',
        'node["tourism"]',
        'node["man_made"]',
        'node["power"]',
    )
    parts = [f"{item}({bbox});" for item in (*way_filters, *node_filters)]
    return "[out:json][timeout:90];(" + "".join(parts) + ");out body;>;out skel qt;"


def project_osm_coordinate(
    latitude: float, longitude: float, bounds: OsmBounds
) -> tuple[float, float]:
    center_latitude = math.radians((bounds.south + bounds.north) / 2)
    center_longitude = math.radians((bounds.west + bounds.east) / 2)
    x = EARTH_RADIUS_M * (math.radians(longitude) - center_longitude) * math.cos(center_latitude)
    y = EARTH_RADIUS_M * (
        math.radians(latitude) - math.radians((bounds.south + bounds.north) / 2)
    )
    return x, y


def classify_road_role(highway: str) -> str:
    return ROAD_ROLE_BY_HIGHWAY.get(highway, "road-local")


def _feature_definition(tags: dict[str, str]) -> FeatureDefinition | None:
    highway = tags.get("highway")
    if highway:
        role = ROAD_ROLE_BY_HIGHWAY.get(highway)
        if role is None:
            return None
        toggle = HIGHWAY_TOGGLE.get(highway, "roads")
        return FeatureDefinition(role, toggle, "line", lambda _: True)
    for definition in FEATURE_DEFINITIONS:
        if definition.matches(tags):
            return definition
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
        return offset_x + (x - min_x) * scale, offset_y + (y - min_y) * scale

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
            distance = abs(
                dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]
            ) / denominator
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
        return lambda a, b: (x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]))

    def horizontal(
        y: float,
    ) -> Callable[[tuple[float, float], tuple[float, float]], tuple[float, float]]:
        return lambda a, b: (a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]), y)

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


def _length(points: list[tuple[float, float]]) -> float:
    return sum(math.dist(first, second) for first, second in pairwise(points))


def _polygon_area(points: list[tuple[float, float]]) -> float:
    polygon = points[:-1] if points and points[0] == points[-1] else points
    if len(polygon) < 3:
        return 0.0
    return abs(
        sum(
            first[0] * second[1] - second[0] * first[1]
            for first, second in pairwise([*polygon, polygon[0]])
        )
    ) / 2


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
            normal_length = math.hypot(nx, ny) or 1
            normal = nx / normal_length, ny / normal_length
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


def _point_inside_polygon(point: tuple[float, float], polygon: list[tuple[float, float]]) -> bool:
    x, y = point
    inside = False
    previous = polygon[-1]
    for current in polygon:
        if (current[1] > y) != (previous[1] > y):
            crossing = (previous[0] - current[0]) * (y - current[1]) / (
                previous[1] - current[1]
            ) + current[0]
            if x < crossing:
                inside = not inside
        previous = current
    return inside


def _stipple_polygon(
    polygon: list[tuple[float, float]], spacing: float, mark_size: float
) -> list[list[tuple[float, float]]]:
    if len(polygon) < 4:
        return []
    min_x = min(point[0] for point in polygon)
    max_x = max(point[0] for point in polygon)
    min_y = min(point[1] for point in polygon)
    max_y = max(point[1] for point in polygon)
    marks: list[list[tuple[float, float]]] = []
    y = math.floor(min_y / spacing) * spacing
    row = 0
    while y <= max_y:
        x = math.floor(min_x / spacing) * spacing + (spacing / 2 if row % 2 else 0)
        while x <= max_x:
            if _point_inside_polygon((x, y), polygon):
                half = mark_size / 2
                marks.append([(x - half, y), (x + half, y)])
                marks.append([(x, y - half), (x, y + half)])
            x += spacing
        y += spacing
        row += 1
    return marks


def _pattern_polyline(
    points: list[tuple[float, float]], pattern: tuple[float, ...]
) -> list[list[tuple[float, float]]]:
    if len(points) < 2 or not pattern:
        return [points]
    result: list[list[tuple[float, float]]] = []
    pattern_index = 0
    remaining = pattern[0]
    drawing = True
    active: list[tuple[float, float]] = []
    for start, end in pairwise(points):
        segment_length = math.dist(start, end)
        if segment_length <= 1e-12:
            continue
        consumed = 0.0
        while consumed < segment_length - 1e-12:
            step = min(remaining, segment_length - consumed)
            first = (
                start[0] + (end[0] - start[0]) * consumed / segment_length,
                start[1] + (end[1] - start[1]) * consumed / segment_length,
            )
            second = (
                start[0] + (end[0] - start[0]) * (consumed + step) / segment_length,
                start[1] + (end[1] - start[1]) * (consumed + step) / segment_length,
            )
            if drawing:
                if not active:
                    active = [first]
                active.append(second)
            consumed += step
            remaining -= step
            if remaining <= 1e-9:
                if drawing and len(active) >= 2:
                    result.append(active)
                    active = []
                pattern_index = (pattern_index + 1) % len(pattern)
                remaining = pattern[pattern_index]
                drawing = pattern_index % 2 == 0
    if drawing and len(active) >= 2:
        result.append(active)
    return result


def _ticks_along_polyline(
    points: list[tuple[float, float]], spacing: float, width: float
) -> list[list[tuple[float, float]]]:
    ticks: list[list[tuple[float, float]]] = []
    if len(points) < 2:
        return ticks
    target = spacing
    travelled = 0.0
    for first, second in pairwise(points):
        dx, dy = second[0] - first[0], second[1] - first[1]
        segment = math.hypot(dx, dy)
        if segment <= 1e-9:
            continue
        while target <= travelled + segment:
            ratio = (target - travelled) / segment
            x = first[0] + dx * ratio
            y = first[1] + dy * ratio
            nx, ny = -dy / segment, dx / segment
            half = width / 2
            ticks.append([(x - nx * half, y - ny * half), (x + nx * half, y + ny * half)])
            target += spacing
        travelled += segment
    return ticks


def _poi_symbol(
    role: str,
    center: tuple[float, float],
    size: float,
    identifier: str,
) -> list[DesignPath]:
    x, y = center
    half = size / 2
    paths: list[list[tuple[float, float]]] = []
    if role in {"poi-worship", "poi-hospital"}:
        paths = [[(x - half, y), (x + half, y)], [(x, y - half), (x, y + half)]]
    elif role in {"poi-station", "poi-tree"}:
        points = [
            (x + half * math.cos(index * math.pi / 6), y + half * math.sin(index * math.pi / 6))
            for index in range(13)
        ]
        paths = [points]
    elif role == "poi-peak":
        paths = [[(x, y + half), (x - half, y - half), (x + half, y - half), (x, y + half)]]
    elif role in {"poi-monument", "poi-historic", "poi-castle"}:
        paths = [[(x, y + half), (x + half, y), (x, y - half), (x - half, y), (x, y + half)]]
    elif role == "poi-lighthouse":
        paths = [
            [(x - half, y), (x + half, y)],
            [(x, y - half), (x, y + half)],
            [(x - half * 0.7, y - half * 0.7), (x + half * 0.7, y + half * 0.7)],
            [(x - half * 0.7, y + half * 0.7), (x + half * 0.7, y - half * 0.7)],
        ]
    elif role == "poi-wind-turbine":
        paths = [
            [(x, y), (x, y + half)],
            [(x, y), (x - half * 0.86, y - half * 0.5)],
            [(x, y), (x + half * 0.86, y - half * 0.5)],
        ]
    else:
        paths = [
            [
                (x - half, y - half),
                (x + half, y - half),
                (x + half, y + half),
                (x - half, y + half),
                (x - half, y - half),
            ]
        ]
    return [
        _polyline_path(f"{identifier}-{index + 1}", points, poi_role=role)
        for index, points in enumerate(paths)
    ]


def _feature_enabled(
    recipe: ProjectRecipe,
    definition: FeatureDefinition,
    tags: dict[str, str],
) -> bool:
    features = recipe.osm.features
    if definition.role.startswith("road-"):
        if not features.roads:
            return False
        highway = tags.get("highway", "")
        toggle = HIGHWAY_TOGGLE.get(highway)
        return bool(getattr(features, toggle)) if toggle else False
    if definition.role in {"water", "waterway", "coastline"} and not features.water:
        return False
    return bool(getattr(features, definition.toggle))


def _polygon_treatment(recipe: ProjectRecipe, role: str) -> str:
    render = recipe.osm.render
    if role == "buildings":
        return render.building_treatment
    if role == "water":
        return render.water_treatment
    if role == "parks":
        return render.park_treatment
    return render.landuse_treatment


def _add_polygon_treatment(
    paths_by_role: dict[str, list[DesignPath]],
    role: str,
    base_id: str,
    polygon: list[tuple[float, float]],
    recipe: ProjectRecipe,
) -> None:
    treatment = _polygon_treatment(recipe, role)
    render = recipe.osm.render
    if treatment in {"outline", "outline-hatch", "crosshatch", "stipple", "ripple"}:
        paths_by_role[role].append(_polyline_path(base_id, polygon, treatment="outline"))
    if treatment in {"hatch", "outline-hatch", "crosshatch", "ripple"}:
        angle = render.polygon_hatch_angle_degrees
        spacing = render.polygon_hatch_spacing_mm
        if role in LANDUSE_HATCH_OVERRIDES:
            angle_offset, spacing_scale = LANDUSE_HATCH_OVERRIDES[role]
            angle += angle_offset
            spacing *= spacing_scale
        if treatment == "ripple":
            angle = render.water_ripple_angle_degrees
            spacing = render.water_ripple_spacing_mm
        hatch_sets = [(angle, "hatch")]
        if treatment == "crosshatch":
            hatch_sets.append((angle + 90, "crosshatch"))
        for hatch_angle, prefix in hatch_sets:
            for hatch_index, hatch in enumerate(
                _hatch_polygon(polygon, spacing=spacing, angle_degrees=hatch_angle)
            ):
                paths_by_role[role].append(
                    _polyline_path(
                        f"{base_id}-{prefix}-{hatch_index}", hatch, treatment=prefix
                    )
                )
    if treatment == "stipple":
        spacing = max(0.5, render.polygon_hatch_spacing_mm)
        mark_size = min(0.6, spacing * 0.3)
        for mark_index, mark in enumerate(_stipple_polygon(polygon, spacing, mark_size)):
            paths_by_role[role].append(
                _polyline_path(f"{base_id}-stipple-{mark_index}", mark, treatment="stipple")
            )


def _add_linear_treatment(
    paths_by_role: dict[str, list[DesignPath]],
    role: str,
    base_id: str,
    group: list[tuple[float, float]],
    tags: dict[str, str],
    recipe: ProjectRecipe,
    rectangle: tuple[float, float, float, float],
) -> None:
    render = recipe.osm.render
    if role.startswith("road-"):
        treatment = render.road_line_treatment
        if treatment == "classified":
            treatment = ROAD_CLASSIFIED_TREATMENTS.get(role, "centerline")
        if tags.get("tunnel") in {"yes", "true", "1"}:
            treatment = "dashed"
        if treatment in {"casing", "parallel"}:
            half_width = render.road_width_mm / 2
            for side, offset in (("left", -half_width), ("right", half_width)):
                for offset_index, offset_group in enumerate(
                    clip_osm_polyline(_offset_polyline(group, offset), rectangle)
                ):
                    paths_by_role[role].append(
                        _polyline_path(
                            f"{base_id}-{side}-{offset_index}",
                            offset_group,
                            treatment="casing",
                        )
                    )
        elif treatment in {"dashed", "dotted"}:
            pattern = (
                (render.dash_length_mm, render.dash_gap_mm)
                if treatment == "dashed"
                else (render.dot_length_mm, render.dot_gap_mm)
            )
            for pattern_index, segment in enumerate(_pattern_polyline(group, pattern)):
                paths_by_role[role].append(
                    _polyline_path(
                        f"{base_id}-{treatment}-{pattern_index}", segment, treatment=treatment
                    )
                )
        else:
            paths_by_role[role].append(_polyline_path(base_id, group, treatment="centerline"))
        if tags.get("bridge") in {"yes", "true", "1"}:
            for tick_index, tick in enumerate(
                _ticks_along_polyline(
                    group,
                    render.bridge_tick_spacing_mm,
                    render.bridge_tick_width_mm,
                )
            ):
                paths_by_role[role].append(
                    _polyline_path(f"{base_id}-bridge-{tick_index}", tick, treatment="bridge-tick")
                )
        return

    if role == "rail":
        treatment = render.rail_treatment
        railway = tags.get("railway", "rail")
        if treatment == "classified":
            treatment = "sleepers" if railway in {"rail", "narrow_gauge"} else "single"
        if tags.get("tunnel") in {"yes", "true", "1"}:
            for index, segment in enumerate(
                _pattern_polyline(group, (render.dash_length_mm, render.dash_gap_mm))
            ):
                paths_by_role[role].append(
                    _polyline_path(f"{base_id}-tunnel-{index}", segment, treatment="tunnel")
                )
            return
        if treatment == "double":
            half = render.rail_width_mm / 2
            for side, offset in (("left", -half), ("right", half)):
                for offset_index, offset_group in enumerate(
                    clip_osm_polyline(_offset_polyline(group, offset), rectangle)
                ):
                    paths_by_role[role].append(
                        _polyline_path(f"{base_id}-{side}-{offset_index}", offset_group)
                    )
        else:
            paths_by_role[role].append(_polyline_path(base_id, group, railway=railway))
            if treatment == "sleepers":
                for index, tick in enumerate(
                    _ticks_along_polyline(
                        group,
                        render.rail_sleeper_spacing_mm,
                        render.rail_width_mm,
                    )
                ):
                    paths_by_role[role].append(_polyline_path(f"{base_id}-sleeper-{index}", tick))
        if tags.get("bridge") in {"yes", "true", "1"}:
            for tick_index, tick in enumerate(
                _ticks_along_polyline(
                    group,
                    render.bridge_tick_spacing_mm,
                    render.bridge_tick_width_mm,
                )
            ):
                paths_by_role[role].append(_polyline_path(f"{base_id}-bridge-{tick_index}", tick))
        return

    if role == "boundary":
        pattern_by_treatment = {
            "solid": None,
            "dashed": (render.dash_length_mm, render.dash_gap_mm),
            "dotted": (render.dot_length_mm, render.dot_gap_mm),
            "dash-dot": (
                render.dash_length_mm,
                render.dash_gap_mm,
                render.dot_length_mm,
                render.dash_gap_mm,
            ),
        }
        pattern = pattern_by_treatment[render.boundary_treatment]
        if pattern is None:
            paths_by_role[role].append(_polyline_path(base_id, group))
        else:
            for index, segment in enumerate(_pattern_polyline(group, pattern)):
                paths_by_role[role].append(_polyline_path(f"{base_id}-pattern-{index}", segment))
        return

    paths_by_role[role].append(_polyline_path(base_id, group))


def generate_osm_design(
    snapshot: dict[str, Any],
    recipe: ProjectRecipe,
    *,
    progress: ProgressCallback | None = None,
    cancel: CancelCallback | None = None,
    terrain_provider: TerrainProvider | None = None,
) -> DesignDocument:
    metadata = recipe.osm.snapshot
    if metadata is None:
        raise ValueError("fetch and freeze an OSM snapshot before generating map artwork")
    bounds = metadata.bounds
    transform = create_osm_page_transform(bounds, recipe)
    elements = snapshot.get("elements")
    if not isinstance(elements, list):
        raise ValueError("OSM snapshot has no elements array")
    nodes = {
        int(item["id"]): (float(item["lat"]), float(item["lon"]))
        for item in elements
        if isinstance(item, dict)
        and item.get("type") == "node"
        and isinstance(item.get("id"), int)
        and isinstance(item.get("lat"), int | float)
        and isinstance(item.get("lon"), int | float)
    }
    ways_by_id = {
        int(item["id"]): item
        for item in elements
        if isinstance(item, dict)
        and item.get("type") == "way"
        and isinstance(item.get("id"), int)
        and isinstance(item.get("nodes"), list)
    }
    rectangle = (
        recipe.page.safe_min.x,
        recipe.page.safe_min.y,
        recipe.page.safe_max.x,
        recipe.page.safe_max.y,
    )
    paths_by_role: dict[str, list[DesignPath]] = defaultdict(list)
    ignored = 0
    filtered = 0
    total = len(elements)
    detail = recipe.osm.detail
    simplification = detail.vertex_simplification_tolerance_mm

    for index, element in enumerate(elements):
        if cancel is not None and index % 50 == 0:
            cancel()
        if not isinstance(element, dict) or element.get("type") != "way":
            continue
        tags = element.get("tags") or {}
        refs = element.get("nodes")
        if not isinstance(tags, dict) or not isinstance(refs, list):
            ignored += 1
            continue
        clean_tags = {str(key): str(value) for key, value in tags.items()}
        definition = _feature_definition(clean_tags)
        if definition is None or not _feature_enabled(recipe, definition, clean_tags):
            continue
        metric = [
            nodes[node_id]
            for node_id in refs
            if isinstance(node_id, int) and node_id in nodes
        ]
        if len(metric) < 2:
            ignored += 1
            continue
        page_points = [
            transform(project_osm_coordinate(latitude, longitude, bounds))
            for latitude, longitude in metric
        ]
        page_points = simplify_osm_points(page_points, simplification)
        closed_polygon = len(page_points) > 3 and refs[0] == refs[-1]
        if definition.geometry == "polygon" and closed_polygon:
            polygon = clip_osm_polygon(page_points, rectangle)
            if not polygon:
                continue
            if _polygon_area(polygon) < detail.minimum_polygon_area_mm2:
                filtered += 1
                continue
            base_id = f"osm-{element.get('id', index)}-0"
            _add_polygon_treatment(paths_by_role, definition.role, base_id, polygon, recipe)
            if definition.role == "buildings" and recipe.osm.render.building_shadow_enabled:
                angle = math.radians(recipe.osm.render.building_shadow_angle_degrees)
                distance = recipe.osm.render.building_shadow_offset_mm
                offset = math.cos(angle) * distance, math.sin(angle) * distance
                shifted = [(point[0] + offset[0], point[1] + offset[1]) for point in polygon]
                shifted = clip_osm_polygon(shifted, rectangle)
                if shifted and _polygon_area(shifted) >= detail.minimum_polygon_area_mm2:
                    paths_by_role[definition.role].append(
                        _polyline_path(f"{base_id}-shadow", shifted, treatment="building-shadow")
                    )
        else:
            groups = clip_osm_polyline(page_points, rectangle)
            for group_index, group in enumerate(groups):
                if _length(group) < detail.minimum_line_length_mm:
                    filtered += 1
                    continue
                base_id = f"osm-{element.get('id', index)}-{group_index}"
                _add_linear_treatment(
                    paths_by_role,
                    definition.role,
                    base_id,
                    group,
                    clean_tags,
                    recipe,
                    rectangle,
                )
        if progress is not None and (index % 25 == 0 or index + 1 == total):
            progress("classify-osm", index + 1, total)

    if recipe.osm.features.boundaries:
        for relation_index, relation in enumerate(elements):
            if not isinstance(relation, dict) or relation.get("type") != "relation":
                continue
            tags = relation.get("tags") or {}
            if not isinstance(tags, dict) or tags.get("boundary") != "administrative":
                continue
            members = relation.get("members")
            if not isinstance(members, list):
                continue
            for member_index, member in enumerate(members):
                if not isinstance(member, dict) or member.get("type") != "way":
                    continue
                way_ref = member.get("ref")
                if not isinstance(way_ref, int):
                    continue
                way = ways_by_id.get(way_ref)
                refs = way.get("nodes") if isinstance(way, dict) else None
                if not isinstance(refs, list):
                    continue
                metric = [
                    nodes[node_id]
                    for node_id in refs
                    if isinstance(node_id, int) and node_id in nodes
                ]
                if len(metric) < 2:
                    continue
                page_points = [
                    transform(project_osm_coordinate(latitude, longitude, bounds))
                    for latitude, longitude in metric
                ]
                page_points = simplify_osm_points(page_points, simplification)
                for group_index, group in enumerate(clip_osm_polyline(page_points, rectangle)):
                    if _length(group) < detail.minimum_line_length_mm:
                        continue
                    _add_linear_treatment(
                        paths_by_role,
                        "boundary",
                        (
                            f"osm-boundary-{relation.get('id', relation_index)}-"
                            f"{member_index}-{group_index}"
                        ),
                        group,
                        {str(key): str(value) for key, value in tags.items()},
                        recipe,
                        rectangle,
                    )

    accepted_pois: list[tuple[float, float]] = []
    if recipe.osm.features.points_of_interest:
        poi_nodes = [
            item
            for item in elements
            if isinstance(item, dict)
            and item.get("type") == "node"
            and isinstance(item.get("tags"), dict)
        ]
        for index, node in enumerate(poi_nodes):
            if cancel is not None and index % 50 == 0:
                cancel()
            tags = {str(key): str(value) for key, value in node.get("tags", {}).items()}
            role = None
            for candidate_role, toggle, matcher in POI_MATCHERS:
                if bool(getattr(recipe.osm.features, toggle)) and matcher(tags):
                    role = candidate_role
                    break
            if role is None:
                continue
            latitude = node.get("lat")
            longitude = node.get("lon")
            if not isinstance(latitude, int | float) or not isinstance(longitude, int | float):
                continue
            point = transform(project_osm_coordinate(float(latitude), float(longitude), bounds))
            if not (
                rectangle[0] <= point[0] <= rectangle[2]
                and rectangle[1] <= point[1] <= rectangle[3]
            ):
                continue
            if any(
                math.dist(point, existing) < detail.minimum_poi_spacing_mm
                for existing in accepted_pois
            ):
                continue
            accepted_pois.append(point)
            paths_by_role[role].extend(
                _poi_symbol(
                    role,
                    point,
                    recipe.osm.poi.symbol_size_mm,
                    f"osm-poi-{node.get('id', index)}",
                )
            )

    if recipe.osm.features.points_of_interest:
        poi_ways = [
            item
            for item in elements
            if isinstance(item, dict)
            and item.get("type") == "way"
            and isinstance(item.get("tags"), dict)
            and isinstance(item.get("nodes"), list)
        ]
        for index, way in enumerate(poi_ways):
            tags = {str(key): str(value) for key, value in way.get("tags", {}).items()}
            role = None
            for candidate_role, toggle, matcher in POI_MATCHERS:
                if bool(getattr(recipe.osm.features, toggle)) and matcher(tags):
                    role = candidate_role
                    break
            if role is None:
                continue
            refs = way.get("nodes")
            if not isinstance(refs, list):
                continue
            coordinates = [
                nodes[node_id]
                for node_id in refs
                if isinstance(node_id, int) and node_id in nodes
            ]
            if not coordinates:
                continue
            latitude = sum(point[0] for point in coordinates) / len(coordinates)
            longitude = sum(point[1] for point in coordinates) / len(coordinates)
            point = transform(project_osm_coordinate(latitude, longitude, bounds))
            if not (
                rectangle[0] <= point[0] <= rectangle[2]
                and rectangle[1] <= point[1] <= rectangle[3]
            ):
                continue
            if any(
                math.dist(point, existing) < detail.minimum_poi_spacing_mm
                for existing in accepted_pois
            ):
                continue
            accepted_pois.append(point)
            paths_by_role[role].extend(
                _poi_symbol(
                    role,
                    point,
                    recipe.osm.poi.symbol_size_mm,
                    f"osm-poi-way-{way.get('id', index)}",
                )
            )

    if recipe.osm.features.power_nodes:
        for index, node in enumerate(elements):
            if not isinstance(node, dict) or node.get("type") != "node":
                continue
            tags = node.get("tags") or {}
            if not isinstance(tags, dict) or tags.get("power") not in {"tower", "pole"}:
                continue
            latitude = node.get("lat")
            longitude = node.get("lon")
            if not isinstance(latitude, int | float) or not isinstance(longitude, int | float):
                continue
            point = transform(project_osm_coordinate(float(latitude), float(longitude), bounds))
            size = recipe.osm.poi.symbol_size_mm * 0.7
            paths_by_role["power-node"].extend(
                _poi_symbol("poi-monument", point, size, f"osm-power-{node.get('id', index)}")
            )

    if recipe.osm.terrain.enabled:
        provider = terrain_provider or AwsTerrariumTerrainProvider()
        grid = provider.get_elevation_grid(
            bounds,
            recipe.osm.terrain.sample_resolution,
            progress=progress,
            cancel=cancel,
        )
        contour_map = generate_contours(
            grid,
            interval_m=recipe.osm.terrain.contour_interval_m,
            elevation_min_m=recipe.osm.terrain.elevation_min_m,
            elevation_max_m=recipe.osm.terrain.elevation_max_m,
            progress=progress,
            cancel=cancel,
        )
        levels = sorted(contour_map)
        for level_index, level in enumerate(levels):
            interval_number = round(level / recipe.osm.terrain.contour_interval_m)
            is_index = interval_number % recipe.osm.terrain.index_contour_every == 0
            role = "terrain-index-contour" if is_index else "terrain-contour"
            for contour_index, lon_lat_path in enumerate(contour_map[level]):
                page_points = [
                    transform(project_osm_coordinate(latitude, longitude, bounds))
                    for longitude, latitude in lon_lat_path
                ]
                page_points = simplify_osm_points(
                    page_points, recipe.osm.terrain.contour_simplification_mm
                )
                for clipped_index, group in enumerate(clip_osm_polyline(page_points, rectangle)):
                    if _length(group) < recipe.osm.terrain.minimum_contour_length_mm:
                        continue
                    paths_by_role[role].append(
                        _polyline_path(
                            f"terrain-{level_index}-{contour_index}-{clipped_index}",
                            group,
                            elevation_m=level,
                            index_contour=is_index,
                        )
                    )

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
                message=f"{ignored} unsupported or incomplete OSM features were not rendered",
            )
        )
    if filtered:
        diagnostics.append(
            DesignDiagnostic(
                code="osm-physical-detail-filter",
                message=f"{filtered} features were removed by physical detail filtering",
            )
        )
    if recipe.osm.terrain.enabled:
        diagnostics.append(
            DesignDiagnostic(
                code="terrain-attribution",
                message="Terrain contours generated from AWS Open Data Terrain Tiles (Terrarium)",
            )
        )
    if progress is not None:
        progress("geometry-filtering", total, total)

    layers = [
        DesignLayer(
            layer_id=f"layer-{role}",
            name=ROLE_STYLE.get(role, (role.replace("-", " ").title(), "#171717"))[0],
            semantic_role=role,
            preview_color=ROLE_STYLE.get(role, ("", "#171717"))[1],
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
