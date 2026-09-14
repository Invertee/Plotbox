from __future__ import annotations

import io
import math
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from typing import Protocol

from PIL import Image

from plotter_core.models import OsmBounds

TERRARIUM_TILE_SIZE = 256
AWS_TERRARIUM_URL = (
    "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
)
MAX_TERRAIN_GRID_SIZE = 512
MAX_TERRAIN_TILES = 64

ProgressCallback = Callable[[str, int | None, int | None], None]
CancelCallback = Callable[[], None]


@dataclass(frozen=True)
class ElevationGrid:
    bounds: OsmBounds
    width: int
    height: int
    values: tuple[tuple[float, ...], ...]

    def elevation(self, x: int, y: int) -> float:
        return self.values[y][x]

    def lon_lat(self, x: float, y: float) -> tuple[float, float]:
        longitude = self.bounds.west + (self.bounds.east - self.bounds.west) * x / max(
            1, self.width - 1
        )
        latitude = self.bounds.north - (self.bounds.north - self.bounds.south) * y / max(
            1, self.height - 1
        )
        return longitude, latitude


class TerrainProvider(Protocol):
    def get_elevation_grid(
        self,
        bounds: OsmBounds,
        resolution: int,
        *,
        progress: ProgressCallback | None = None,
        cancel: CancelCallback | None = None,
    ) -> ElevationGrid: ...


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _mercator_tile_xy(longitude: float, latitude: float, zoom: int) -> tuple[float, float]:
    latitude = _clamp(latitude, -85.05112878, 85.05112878)
    scale = 2**zoom
    x = (longitude + 180.0) / 360.0 * scale
    latitude_radians = math.radians(latitude)
    y = (
        1.0
        - math.asinh(math.tan(latitude_radians)) / math.pi
    ) / 2.0 * scale
    return x, y


def _choose_zoom(bounds: OsmBounds, resolution: int) -> int:
    resolution = max(16, min(MAX_TERRAIN_GRID_SIZE, resolution))
    lon_span = max(1e-9, bounds.east - bounds.west)
    center_latitude = (bounds.south + bounds.north) / 2
    lat_scale = max(0.1, math.cos(math.radians(center_latitude)))
    effective_span = max(lon_span, (bounds.north - bounds.south) / lat_scale)
    required_world_pixels = resolution * 360.0 / effective_span
    zoom = round(math.log2(required_world_pixels / TERRARIUM_TILE_SIZE))
    return max(5, min(14, zoom))


def _decode_terrarium(image: Image.Image) -> tuple[tuple[float, ...], ...]:
    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    return tuple(
        tuple(
            pixels[x, y][0] * 256.0
            + pixels[x, y][1]
            + pixels[x, y][2] / 256.0
            - 32768.0
            for x in range(width)
        )
        for y in range(height)
    )


@lru_cache(maxsize=32)
def _fetch_terrarium_tile(
    zoom: int,
    x: int,
    y: int,
    url_template: str,
) -> tuple[tuple[float, ...], ...]:
    limit = 2**zoom
    x %= limit
    if y < 0 or y >= limit:
        return tuple(
            tuple(0.0 for _ in range(TERRARIUM_TILE_SIZE))
            for _ in range(TERRARIUM_TILE_SIZE)
        )
    url = url_template.format(z=zoom, x=x, y=y)
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "image/png",
            "User-Agent": "Plotbox/0.4 terrain-contours",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read(4 * 1024 * 1024)
    with Image.open(io.BytesIO(payload)) as image:
        if image.size != (TERRARIUM_TILE_SIZE, TERRARIUM_TILE_SIZE):
            raise ValueError(f"unexpected terrain tile size {image.size}")
        return _decode_terrarium(image)


class AwsTerrariumTerrainProvider:
    def __init__(self, url_template: str = AWS_TERRARIUM_URL) -> None:
        self.url_template = url_template

    def get_elevation_grid(
        self,
        bounds: OsmBounds,
        resolution: int,
        *,
        progress: ProgressCallback | None = None,
        cancel: CancelCallback | None = None,
    ) -> ElevationGrid:
        size = max(16, min(MAX_TERRAIN_GRID_SIZE, int(resolution)))
        zoom = _choose_zoom(bounds, size)
        west_x, north_y = _mercator_tile_xy(bounds.west, bounds.north, zoom)
        east_x, south_y = _mercator_tile_xy(bounds.east, bounds.south, zoom)
        min_tile_x = math.floor(min(west_x, east_x))
        max_tile_x = math.floor(max(west_x, east_x))
        min_tile_y = math.floor(min(north_y, south_y))
        max_tile_y = math.floor(max(north_y, south_y))
        tile_count = (max_tile_x - min_tile_x + 1) * (max_tile_y - min_tile_y + 1)
        if tile_count > MAX_TERRAIN_TILES:
            raise ValueError(
                f"terrain request spans {tile_count} tiles; maximum is {MAX_TERRAIN_TILES}. "
                "Reduce map extent or terrain resolution."
            )

        tiles: dict[tuple[int, int], tuple[tuple[float, ...], ...]] = {}
        completed = 0
        for tile_y in range(min_tile_y, max_tile_y + 1):
            for tile_x in range(min_tile_x, max_tile_x + 1):
                if cancel is not None:
                    cancel()
                tiles[(tile_x, tile_y)] = _fetch_terrarium_tile(
                    zoom, tile_x, tile_y, self.url_template
                )
                completed += 1
                if progress is not None:
                    progress("terrain-download", completed, tile_count)

        values: list[tuple[float, ...]] = []
        for row in range(size):
            if cancel is not None and row % 8 == 0:
                cancel()
            latitude = bounds.north - (bounds.north - bounds.south) * row / max(1, size - 1)
            row_values: list[float] = []
            for column in range(size):
                longitude = bounds.west + (bounds.east - bounds.west) * column / max(1, size - 1)
                tile_x_float, tile_y_float = _mercator_tile_xy(longitude, latitude, zoom)
                tile_x = math.floor(tile_x_float)
                tile_y = math.floor(tile_y_float)
                local_x = int((tile_x_float - tile_x) * TERRARIUM_TILE_SIZE)
                local_y = int((tile_y_float - tile_y) * TERRARIUM_TILE_SIZE)
                local_x = max(0, min(TERRARIUM_TILE_SIZE - 1, local_x))
                local_y = max(0, min(TERRARIUM_TILE_SIZE - 1, local_y))
                row_values.append(tiles[(tile_x, tile_y)][local_y][local_x])
            values.append(tuple(row_values))
        return ElevationGrid(bounds=bounds, width=size, height=size, values=tuple(values))


def _interpolate(
    first: tuple[float, float],
    second: tuple[float, float],
    first_value: float,
    second_value: float,
    level: float,
) -> tuple[float, float]:
    if math.isclose(first_value, second_value):
        ratio = 0.5
    else:
        ratio = (level - first_value) / (second_value - first_value)
    ratio = _clamp(ratio, 0.0, 1.0)
    return (
        first[0] + (second[0] - first[0]) * ratio,
        first[1] + (second[1] - first[1]) * ratio,
    )


def _cell_segments(
    values: tuple[float, float, float, float],
    level: float,
    x: int,
    y: int,
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    top_left, top_right, bottom_right, bottom_left = values
    corners = (
        (float(x), float(y)),
        (float(x + 1), float(y)),
        (float(x + 1), float(y + 1)),
        (float(x), float(y + 1)),
    )
    edges: list[tuple[float, float]] = []
    edge_defs = (
        (0, 1, top_left, top_right),
        (1, 2, top_right, bottom_right),
        (2, 3, bottom_right, bottom_left),
        (3, 0, bottom_left, top_left),
    )
    for first_index, second_index, first_value, second_value in edge_defs:
        crosses = (first_value < level <= second_value) or (second_value < level <= first_value)
        if crosses:
            edges.append(
                _interpolate(
                    corners[first_index],
                    corners[second_index],
                    first_value,
                    second_value,
                    level,
                )
            )
    if len(edges) == 2:
        return [(edges[0], edges[1])]
    if len(edges) == 4:
        center = sum(values) / 4.0
        if center >= level:
            return [(edges[0], edges[1]), (edges[2], edges[3])]
        return [(edges[0], edges[3]), (edges[1], edges[2])]
    return []


def _point_key(point: tuple[float, float], precision: int = 6) -> tuple[float, float]:
    return round(point[0], precision), round(point[1], precision)


def _join_segments(
    segments: list[tuple[tuple[float, float], tuple[float, float]]],
) -> list[list[tuple[float, float]]]:
    adjacency: dict[tuple[float, float], list[tuple[float, float]]] = {}
    original: dict[tuple[float, float], tuple[float, float]] = {}
    for first, second in segments:
        first_key = _point_key(first)
        second_key = _point_key(second)
        adjacency.setdefault(first_key, []).append(second_key)
        adjacency.setdefault(second_key, []).append(first_key)
        original[first_key] = first
        original[second_key] = second

    used: set[tuple[tuple[float, float], tuple[float, float]]] = set()
    paths: list[list[tuple[float, float]]] = []

    def edge_key(
        a: tuple[float, float],
        b: tuple[float, float],
    ) -> tuple[tuple[float, float], tuple[float, float]]:
        return (a, b) if a <= b else (b, a)

    starts = [key for key, neighbours in adjacency.items() if len(neighbours) == 1]
    starts.extend(key for key in adjacency if key not in starts)
    for start in starts:
        for neighbour in adjacency[start]:
            if edge_key(start, neighbour) in used:
                continue
            path = [original[start]]
            current = start
            next_key = neighbour
            while True:
                used.add(edge_key(current, next_key))
                path.append(original[next_key])
                candidates = [
                    candidate
                    for candidate in adjacency[next_key]
                    if edge_key(next_key, candidate) not in used
                ]
                if not candidates:
                    break
                current, next_key = next_key, candidates[0]
            if len(path) >= 2:
                paths.append(path)
    return paths


def contour_levels(
    grid: ElevationGrid,
    interval_m: float,
    elevation_min_m: float | None = None,
    elevation_max_m: float | None = None,
) -> list[float]:
    if interval_m <= 0:
        raise ValueError("contour interval must be positive")
    flat = [value for row in grid.values for value in row if math.isfinite(value)]
    if not flat:
        return []
    minimum = max(min(flat), elevation_min_m) if elevation_min_m is not None else min(flat)
    maximum = min(max(flat), elevation_max_m) if elevation_max_m is not None else max(flat)
    if minimum > maximum:
        return []
    first = math.ceil(minimum / interval_m) * interval_m
    count = max(0, math.floor((maximum - first) / interval_m) + 1)
    return [first + index * interval_m for index in range(count)]


def generate_contours(
    grid: ElevationGrid,
    *,
    interval_m: float,
    elevation_min_m: float | None = None,
    elevation_max_m: float | None = None,
    progress: ProgressCallback | None = None,
    cancel: CancelCallback | None = None,
) -> dict[float, list[list[tuple[float, float]]]]:
    levels = contour_levels(grid, interval_m, elevation_min_m, elevation_max_m)
    output: dict[float, list[list[tuple[float, float]]]] = {}
    for level_index, level in enumerate(levels):
        segments: list[tuple[tuple[float, float], tuple[float, float]]] = []
        for y in range(grid.height - 1):
            if cancel is not None and y % 8 == 0:
                cancel()
            for x in range(grid.width - 1):
                segments.extend(
                    _cell_segments(
                        (
                            grid.elevation(x, y),
                            grid.elevation(x + 1, y),
                            grid.elevation(x + 1, y + 1),
                            grid.elevation(x, y + 1),
                        ),
                        level,
                        x,
                        y,
                    )
                )
        paths = _join_segments(segments)
        output[level] = [
            [grid.lon_lat(point[0], point[1]) for point in path]
            for path in paths
            if len(path) >= 2
        ]
        if progress is not None:
            progress("terrain-contours", level_index + 1, len(levels))
    return output
