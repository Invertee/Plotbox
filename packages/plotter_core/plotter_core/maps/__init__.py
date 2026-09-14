from plotter_core.maps.osm import (
    MAX_QUERY_AREA_KM2,
    build_overpass_query,
    classify_road_role,
    clip_osm_polygon,
    clip_osm_polyline,
    create_osm_page_transform,
    generate_osm_design,
    project_osm_coordinate,
    selection_area_km2,
    simplify_osm_points,
)
from plotter_core.maps.query import OsmPlace, OsmPlaceFetcher, fetch_osm_places

__all__ = [
    "MAX_QUERY_AREA_KM2",
    "OsmPlace",
    "OsmPlaceFetcher",
    "build_overpass_query",
    "classify_road_role",
    "clip_osm_polygon",
    "clip_osm_polyline",
    "create_osm_page_transform",
    "fetch_osm_places",
    "generate_osm_design",
    "project_osm_coordinate",
    "selection_area_km2",
    "simplify_osm_points",
]

# terrain exports v0.4.1
from plotter_core.maps.terrain import (
    AwsTerrariumTerrainProvider,
    ElevationGrid,
    TerrainProvider,
    generate_contours,
)

__all__ += [
    "AwsTerrariumTerrainProvider",
    "ElevationGrid",
    "TerrainProvider",
    "generate_contours",
]
