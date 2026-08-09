from __future__ import annotations

import struct

from plotter_core.models import (
    CompactGeometry,
    CompactGeometryLayer,
    DesignDocument,
)
from plotter_core.planning import flatten_design_path


def _float32(value: float) -> float:
    result: float = struct.unpack("<f", struct.pack("<f", value))[0]
    return result


def compact_design_geometry(
    design: DesignDocument,
    *,
    curve_tolerance_mm: float,
) -> CompactGeometry:
    vertices_xy: list[float] = []
    path_offsets = [0]
    path_flags: list[int] = []
    layers: list[CompactGeometryLayer] = []
    path_index = 0
    point_count = 0

    for layer in design.layers:
        first_path = path_index
        for path in layer.paths:
            points = flatten_design_path(path, curve_tolerance_mm)
            if len(points) < 2:
                continue
            for point in points:
                vertices_xy.extend((_float32(point.x), _float32(point.y)))
            point_count += len(points)
            path_offsets.append(point_count)
            path_flags.append((1 if path.closed else 0) | (2 if path.reversible else 0))
            path_index += 1
        layers.append(
            CompactGeometryLayer(
                layer_id=layer.layer_id,
                name=layer.name,
                preview_color=layer.preview_color,
                first_path=first_path,
                path_count=path_index - first_path,
            )
        )

    return CompactGeometry(
        vertices_xy=vertices_xy,
        path_offsets=path_offsets,
        path_flags=path_flags,
        layers=layers,
        source_design_sha256=design.metadata.normalized_sha256,
    )
