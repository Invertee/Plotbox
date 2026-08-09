from __future__ import annotations

import math

from hypothesis import given, settings
from hypothesis import strategies as st
from plotter_core.generator import generate_test_design
from plotter_core.models import (
    DesignPath,
    MoveCommand,
    PlannedPath,
    Point,
    ProjectRecipe,
    QuadraticCommand,
)
from plotter_core.planning import (
    _merge_compatible_paths,
    build_plot_plan,
    clip_polyline,
    flatten_design_path,
)


def test_quadratic_flattening_respects_physical_tolerance() -> None:
    path = DesignPath(
        path_id="quadratic",
        commands=[
            MoveCommand(point=Point(x=0, y=0)),
            QuadraticCommand(
                control=Point(x=5, y=10),
                point=Point(x=10, y=0),
            ),
        ],
    )
    coarse = flatten_design_path(path, 1.0)
    fine = flatten_design_path(path, 0.05)
    assert len(fine) > len(coarse)
    assert fine[0] == Point(x=0, y=0)
    assert fine[-1] == Point(x=10, y=0)


@given(
    x1=st.floats(-100, 500, allow_nan=False, allow_infinity=False),
    y1=st.floats(-100, 400, allow_nan=False, allow_infinity=False),
    x2=st.floats(-100, 500, allow_nan=False, allow_infinity=False),
    y2=st.floats(-100, 400, allow_nan=False, allow_infinity=False),
)
@settings(max_examples=80)
def test_clipped_line_fragments_are_finite_and_in_bounds(
    x1: float, y1: float, x2: float, y2: float
) -> None:
    if math.isclose(x1, x2) and math.isclose(y1, y2):
        return
    minimum = Point(x=10, y=10)
    maximum = Point(x=410, y=287)
    fragments, _ = clip_polyline([Point(x=x1, y=y1), Point(x=x2, y=y2)], minimum, maximum)
    for fragment in fragments:
        assert len(fragment) >= 2
        assert all(10 - 1e-9 <= point.x <= 410 + 1e-9 for point in fragment)
        assert all(10 - 1e-9 <= point.y <= 287 + 1e-9 for point in fragment)


def test_plan_has_two_ordered_passes_explicit_travel_and_statistics() -> None:
    recipe = ProjectRecipe(project_id="plan", name="Plan")
    design = generate_test_design(recipe)
    plan = build_plot_plan(recipe, design)
    assert [plot_pass.pass_id for plot_pass in plan.passes] == [
        "pass-black",
        "pass-cyan",
    ]
    assert plan.statistics.path_count > 10
    assert plan.statistics.vertex_count > plan.statistics.path_count
    assert plan.statistics.draw_length_mm > 0
    assert plan.statistics.travel_length_mm > 0
    assert plan.statistics.lift_count == plan.statistics.path_count
    assert len(plan.travel_segments) == plan.statistics.path_count
    assert sum(action.kind == "pause_for_pen" for action in plan.actions) == 1
    for plot_pass in plan.passes:
        for path in plot_pass.ordered_paths:
            assert all(
                recipe.page.margin_mm - 1e-9
                <= point.x
                <= recipe.page.width_mm - recipe.page.margin_mm + 1e-9
                for point in path.points
            )


def test_empty_plan_is_blocking_and_explains_recovery() -> None:
    recipe = ProjectRecipe(project_id="empty-plan", name="Empty plan")
    recipe.passes = [
        recipe.passes[0].model_copy(update={"semantic_role": "missing", "source_layer_ids": []})
    ]
    design = generate_test_design(recipe)

    plan = build_plot_plan(recipe, design)

    assert plan.statistics.path_count == 0
    empty_warning = next(warning for warning in plan.warnings if warning.code == "empty-plan")
    assert empty_warning.blocking
    assert "Review enabled pen passes" in empty_warning.message


def test_compatible_open_paths_merge_without_changing_drawn_points() -> None:
    paths = [
        PlannedPath(
            path_id="a",
            source_layer_id="layer",
            points=[Point(x=0, y=0), Point(x=1, y=0)],
            reversible=True,
            closed=False,
        ),
        PlannedPath(
            path_id="b",
            source_layer_id="layer",
            points=[Point(x=1, y=0), Point(x=2, y=0)],
            reversible=True,
            closed=False,
        ),
    ]
    merged = _merge_compatible_paths(paths, 0.01)
    assert len(merged) == 1
    assert merged[0].points == [
        Point(x=0, y=0),
        Point(x=1, y=0),
        Point(x=2, y=0),
    ]
