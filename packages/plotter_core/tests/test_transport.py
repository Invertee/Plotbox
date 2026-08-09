from __future__ import annotations

import json

from plotter_core.generator import generate_test_design
from plotter_core.models import ProjectRecipe
from plotter_core.transport import compact_design_geometry


def test_compact_geometry_contract_is_smaller_than_point_object_json() -> None:
    design = generate_test_design(ProjectRecipe(project_id="transport", name="Transport"))
    compact = compact_design_geometry(design, curve_tolerance_mm=0.05)
    points = [
        {"x": compact.vertices_xy[index], "y": compact.vertices_xy[index + 1]}
        for index in range(0, len(compact.vertices_xy), 2)
    ]
    compact_bytes = len(
        json.dumps(compact.model_dump(mode="json"), separators=(",", ":")).encode("utf-8")
    )
    verbose_bytes = len(json.dumps({"points": points}, separators=(",", ":")).encode("utf-8"))
    assert len(compact.path_offsets) == len(compact.path_flags) + 1
    assert compact.path_offsets[-1] * 2 == len(compact.vertices_xy)
    assert compact_bytes < verbose_bytes
