from __future__ import annotations

import math
from collections.abc import Callable, Iterable
from functools import partial
from itertools import pairwise

from plotter_core.models import (
    CloseCommand,
    CubicCommand,
    DesignDocument,
    DesignPath,
    LineCommand,
    MoveCommand,
    PlannedPath,
    PlanWarning,
    PlotAction,
    PlotPass,
    PlotPlan,
    PlotStatistics,
    Point,
    ProjectRecipe,
    QuadraticCommand,
    RemovedGeometryReport,
    TravelSegment,
    canonical_sha256,
)


def distance(first: Point, second: Point) -> float:
    return math.hypot(second.x - first.x, second.y - first.y)


def _point_line_distance(point: Point, start: Point, end: Point) -> float:
    line_length = distance(start, end)
    if line_length == 0:
        return distance(point, start)
    return (
        abs(
            (end.y - start.y) * point.x
            - (end.x - start.x) * point.y
            + end.x * start.y
            - end.y * start.x
        )
        / line_length
    )


def _quadratic_point(start: Point, control: Point, end: Point, t: float) -> Point:
    inverse = 1.0 - t
    return Point(
        x=inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
        y=inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y,
    )


def _cubic_point(start: Point, control1: Point, control2: Point, end: Point, t: float) -> Point:
    inverse = 1.0 - t
    return Point(
        x=inverse**3 * start.x
        + 3 * inverse * inverse * t * control1.x
        + 3 * inverse * t * t * control2.x
        + t**3 * end.x,
        y=inverse**3 * start.y
        + 3 * inverse * inverse * t * control1.y
        + 3 * inverse * t * t * control2.y
        + t**3 * end.y,
    )


def _quadratic_at(t: float, *, start: Point, control: Point, end: Point) -> Point:
    return _quadratic_point(start, control, end, t)


def _cubic_at(
    t: float,
    *,
    start: Point,
    control1: Point,
    control2: Point,
    end: Point,
) -> Point:
    return _cubic_point(start, control1, control2, end, t)


def _flatten_parametric(
    evaluate: Callable[[float], Point],
    start: Point,
    end: Point,
    tolerance: float,
    depth: int = 0,
) -> list[Point]:
    midpoint = evaluate(0.5)
    if depth >= 18 or _point_line_distance(midpoint, start, end) <= tolerance:
        return [end]

    def left_evaluate(t: float) -> Point:
        return evaluate(t * 0.5)

    def right_evaluate(t: float) -> Point:
        return evaluate(0.5 + t * 0.5)

    return _flatten_parametric(
        left_evaluate, start, midpoint, tolerance, depth + 1
    ) + _flatten_parametric(right_evaluate, midpoint, end, tolerance, depth + 1)


def flatten_design_path(path: DesignPath, tolerance_mm: float) -> list[Point]:
    first = path.commands[0]
    if not isinstance(first, MoveCommand):
        raise ValueError("path must begin with move")
    start = first.point
    current = start
    points = [start]
    for command in path.commands[1:]:
        if isinstance(command, MoveCommand):
            raise ValueError("multiple subpaths must be represented as separate DesignPath objects")
        if isinstance(command, LineCommand):
            points.append(command.point)
            current = command.point
        elif isinstance(command, QuadraticCommand):
            curve_start = current
            points.extend(
                _flatten_parametric(
                    partial(
                        _quadratic_at,
                        start=curve_start,
                        control=command.control,
                        end=command.point,
                    ),
                    curve_start,
                    command.point,
                    tolerance_mm,
                )
            )
            current = command.point
        elif isinstance(command, CubicCommand):
            curve_start = current
            points.extend(
                _flatten_parametric(
                    partial(
                        _cubic_at,
                        start=curve_start,
                        control1=command.control1,
                        control2=command.control2,
                        end=command.point,
                    ),
                    curve_start,
                    command.point,
                    tolerance_mm,
                )
            )
            current = command.point
        elif isinstance(command, CloseCommand):
            if distance(current, start) > 1e-12:
                points.append(start)
            current = start
    return _deduplicate_adjacent(points)


def _deduplicate_adjacent(points: Iterable[Point]) -> list[Point]:
    result: list[Point] = []
    for point in points:
        if not result or distance(result[-1], point) > 1e-12:
            result.append(point)
    return result


def _clip_segment(
    start: Point, end: Point, minimum: Point, maximum: Point
) -> tuple[Point, Point] | None:
    dx = end.x - start.x
    dy = end.y - start.y
    p = (-dx, dx, -dy, dy)
    q = (
        start.x - minimum.x,
        maximum.x - start.x,
        start.y - minimum.y,
        maximum.y - start.y,
    )
    low, high = 0.0, 1.0
    for denominator, numerator in zip(p, q, strict=True):
        if denominator == 0:
            if numerator < 0:
                return None
            continue
        ratio = numerator / denominator
        if denominator < 0:
            low = max(low, ratio)
        else:
            high = min(high, ratio)
        if low > high:
            return None
    return (
        Point(x=start.x + low * dx, y=start.y + low * dy),
        Point(x=start.x + high * dx, y=start.y + high * dy),
    )


def clip_polyline(
    points: list[Point], minimum: Point, maximum: Point
) -> tuple[list[list[Point]], bool]:
    fragments: list[list[Point]] = []
    clipped = False
    current: list[Point] = []
    for start, end in pairwise(points):
        segment = _clip_segment(start, end, minimum, maximum)
        if segment is None:
            clipped = True
            if len(current) >= 2:
                fragments.append(_deduplicate_adjacent(current))
            current = []
            continue
        clipped_start, clipped_end = segment
        if distance(start, clipped_start) > 1e-9 or distance(end, clipped_end) > 1e-9:
            clipped = True
        if not current or distance(current[-1], clipped_start) > 1e-9:
            if len(current) >= 2:
                fragments.append(_deduplicate_adjacent(current))
            current = [clipped_start]
        current.append(clipped_end)
    if len(current) >= 2:
        fragments.append(_deduplicate_adjacent(current))
    return [fragment for fragment in fragments if len(fragment) >= 2], clipped


def _polyline_length(points: list[Point]) -> float:
    return sum(distance(start, end) for start, end in pairwise(points))


def _snap_endpoints(paths: list[PlannedPath], tolerance: float) -> list[PlannedPath]:
    if tolerance <= 0:
        return paths
    endpoints: list[Point] = []
    result: list[PlannedPath] = []
    for path in paths:
        if path.kind == "dot":
            result.append(path)
            continue
        points = list(path.points)
        for index in (0, -1):
            candidate = points[index]
            match = next(
                (existing for existing in endpoints if distance(existing, candidate) <= tolerance),
                None,
            )
            if match is None:
                endpoints.append(candidate)
            else:
                points[index] = match
        result.append(path.model_copy(update={"points": points}))
    return result


def _merge_compatible_paths(paths: list[PlannedPath], tolerance: float) -> list[PlannedPath]:
    remaining = list(paths)
    merged: list[PlannedPath] = []
    while remaining:
        current = remaining.pop(0)
        if current.closed or current.kind == "dot":
            merged.append(current)
            continue
        changed = True
        while changed:
            changed = False
            for index, candidate in enumerate(remaining):
                if (
                    candidate.closed
                    or candidate.kind == "dot"
                    or candidate.source_layer_id != current.source_layer_id
                ):
                    continue
                combinations: list[tuple[float, list[Point]]] = [
                    (
                        distance(current.points[-1], candidate.points[0]),
                        current.points + candidate.points[1:],
                    )
                ]
                if candidate.reversible:
                    combinations.append(
                        (
                            distance(current.points[-1], candidate.points[-1]),
                            current.points + list(reversed(candidate.points[:-1])),
                        )
                    )
                if current.reversible:
                    combinations.append(
                        (
                            distance(current.points[0], candidate.points[-1]),
                            candidate.points + current.points[1:],
                        )
                    )
                proximity, combined_points = min(combinations, key=lambda item: item[0])
                if proximity <= tolerance:
                    remaining.pop(index)
                    current = PlannedPath(
                        path_id=f"{current.path_id}+{candidate.path_id}",
                        source_layer_id=current.source_layer_id,
                        points=_deduplicate_adjacent(combined_points),
                        reversible=current.reversible and candidate.reversible,
                        closed=False,
                    )
                    changed = True
                    break
        merged.append(current)
    return merged


def _order_paths(
    paths: list[PlannedPath],
    start: Point,
    *,
    grid_order: bool = False,
) -> list[PlannedPath]:
    if grid_order:
        # Halftone marks are already emitted in a stable physical grid. A spatial sort avoids
        # quadratic nearest-neighbour work for dense raster pages while preserving every mark.
        return sorted(
            paths,
            key=lambda path: (
                round(path.points[0].y, 6),
                round(path.points[0].x, 6),
                path.path_id,
            ),
        )
    remaining = list(paths)
    ordered: list[PlannedPath] = []
    current = start
    while remaining:
        best_index = 0
        reverse = False
        best_distance = math.inf
        for index, path in enumerate(remaining):
            start_distance = distance(current, path.points[0])
            if start_distance < best_distance:
                best_index, reverse, best_distance = index, False, start_distance
            if path.reversible:
                end_distance = distance(current, path.points[-1])
                if end_distance < best_distance:
                    best_index, reverse, best_distance = index, True, end_distance
        selected = remaining.pop(best_index)
        if reverse:
            selected = selected.model_copy(update={"points": list(reversed(selected.points))})
        ordered.append(selected)
        current = selected.points[-1]
    return ordered


def build_plot_plan(recipe: ProjectRecipe, design: DesignDocument) -> PlotPlan:
    """Create a controller-independent ordered plan with explicit travel and pen actions."""
    if design.page != recipe.page:
        raise ValueError("design page does not match project recipe page")

    layer_by_role = {layer.semantic_role: layer for layer in design.layers}
    layer_by_id = {layer.layer_id: layer for layer in design.layers}
    minimum = recipe.page.safe_min
    maximum = recipe.page.safe_max
    removed = RemovedGeometryReport()
    warnings: list[PlanWarning] = []
    passes: list[PlotPass] = []

    for pass_settings in recipe.passes:
        if not pass_settings.enabled:
            continue
        selected_layers = (
            [
                layer_by_id[layer_id]
                for layer_id in pass_settings.source_layer_ids
                if layer_id in layer_by_id
            ]
            if pass_settings.source_layer_ids
            else [layer_by_role[pass_settings.semantic_role]]
            if pass_settings.semantic_role in layer_by_role
            else []
        )
        if not selected_layers:
            warnings.append(
                PlanWarning(
                    code="missing-layer",
                    message=(
                        f"No design layer exists for pass {pass_settings.name} "
                        f"({pass_settings.semantic_role}). Review the pass-to-layer mapping "
                        "and apply the pass changes."
                    ),
                )
            )
            continue
        planned: list[PlannedPath] = []
        for layer in selected_layers:
            for source in layer.paths:
                flattened = flatten_design_path(source, recipe.geometry.curve_tolerance_mm)
                is_pen_dot = source.metadata.get("mark_kind") == "pen-dot"
                if is_pen_dot and len(flattened) == 1:
                    point = flattened[0]
                    if not (
                        minimum.x <= point.x <= maximum.x and minimum.y <= point.y <= maximum.y
                    ):
                        removed = removed.model_copy(
                            update={"clipped_paths": removed.clipped_paths + 1}
                        )
                        continue
                    diameter = source.metadata.get("dot_diameter_mm")
                    if not isinstance(diameter, (int, float)) or diameter <= 0:
                        raise ValueError("pen-dot path is missing a positive dot diameter")
                    planned.append(
                        PlannedPath(
                            path_id=source.path_id,
                            source_layer_id=layer.layer_id,
                            points=[point],
                            reversible=False,
                            closed=False,
                            kind="dot",
                            dot_diameter_mm=float(diameter),
                        )
                    )
                    continue
                if len(flattened) < 2:
                    removed = removed.model_copy(
                        update={"degenerate_paths": removed.degenerate_paths + 1}
                    )
                    continue
                fragments, was_clipped = clip_polyline(flattened, minimum, maximum)
                if was_clipped:
                    removed = removed.model_copy(
                        update={"clipped_paths": removed.clipped_paths + 1}
                    )
                for fragment_index, fragment in enumerate(fragments):
                    if _polyline_length(fragment) < recipe.geometry.minimum_path_length_mm:
                        removed = removed.model_copy(
                            update={"short_paths": removed.short_paths + 1}
                        )
                        continue
                    suffix = f"-clip-{fragment_index}" if len(fragments) > 1 else ""
                    planned.append(
                        PlannedPath(
                            path_id=f"{source.path_id}{suffix}",
                            source_layer_id=layer.layer_id,
                            points=fragment,
                            reversible=source.reversible and not source.closed,
                            closed=source.closed and not was_clipped,
                        )
                    )
        snapped = _snap_endpoints(planned, recipe.geometry.endpoint_snap_tolerance_mm)
        merged = _merge_compatible_paths(snapped, recipe.geometry.endpoint_snap_tolerance_mm)
        ordered = _order_paths(
            merged,
            Point(x=0.0, y=0.0),
            # Raster halftoning emits independent marks on a physical grid.  A normal
            # nearest-neighbour pass is O(n²), which becomes prohibitively expensive
            # for the tens of thousands of marks a dense stipple can contain.  The
            # grid traversal is O(n log n) and remains deterministic.  Natural
            # stipples retain their jitter; this only chooses their draw order.
            grid_order=all(
                layer.metadata.get("algorithm") in {"dither", "stipple"}
                for layer in selected_layers
            ),
        )
        passes.append(
            PlotPass(
                pass_id=pass_settings.pass_id,
                name=pass_settings.name,
                semantic_role=pass_settings.semantic_role,
                preview_color=pass_settings.preview_color,
                pen_profile_id=pass_settings.pen_profile_id,
                draw_feed_mm_min=pass_settings.draw_feed_mm_min,
                enabled=True,
                ordered_paths=ordered,
                source_layer_ids=pass_settings.source_layer_ids,
                pen_down_override=pass_settings.pen_down_override,
            )
        )

    travel_segments: list[TravelSegment] = []
    actions: list[PlotAction] = []
    current = Point(x=0.0, y=0.0)
    for pass_index, plot_pass in enumerate(passes):
        actions.append(PlotAction(kind="pen_up", pass_id=plot_pass.pass_id))
        for path in plot_pass.ordered_paths:
            travel = TravelSegment(start=current, end=path.points[0], pass_id=plot_pass.pass_id)
            travel_segments.append(travel)
            actions.append(
                PlotAction(
                    kind="travel",
                    pass_id=plot_pass.pass_id,
                    path_id=path.path_id,
                    start=current,
                    end=path.points[0],
                )
            )
            actions.append(
                PlotAction(kind="pen_down", pass_id=plot_pass.pass_id, path_id=path.path_id)
            )
            for start, end in pairwise(path.points):
                actions.append(
                    PlotAction(
                        kind="draw",
                        pass_id=plot_pass.pass_id,
                        path_id=path.path_id,
                        start=start,
                        end=end,
                    )
                )
            actions.append(
                PlotAction(kind="pen_up", pass_id=plot_pass.pass_id, path_id=path.path_id)
            )
            current = path.points[-1]
        if pass_index < len(passes) - 1:
            actions.append(
                PlotAction(
                    kind="pause_for_pen",
                    pass_id=plot_pass.pass_id,
                    message=f"Change pen to {passes[pass_index + 1].name}",
                )
            )

    draw_length = sum(
        _polyline_length(path.points) for plot_pass in passes for path in plot_pass.ordered_paths
    )
    travel_length = sum(distance(item.start, item.end) for item in travel_segments)
    draw_seconds = sum(
        _polyline_length(path.points) / plot_pass.draw_feed_mm_min * 60
        for plot_pass in passes
        for path in plot_pass.ordered_paths
    )
    travel_seconds = travel_length / 6000.0 * 60
    lift_count = sum(len(plot_pass.ordered_paths) for plot_pass in passes)
    statistics = PlotStatistics(
        layer_count=len(design.layers),
        pass_count=len(passes),
        path_count=lift_count,
        vertex_count=sum(
            len(path.points) for plot_pass in passes for path in plot_pass.ordered_paths
        ),
        draw_length_mm=draw_length,
        travel_length_mm=travel_length,
        lift_count=lift_count,
        estimated_seconds=draw_seconds + travel_seconds,
    )
    if statistics.path_count == 0:
        warnings.append(
            PlanWarning(
                code="empty-plan",
                message=(
                    "The plan contains no drawable paths. Review enabled pen passes and their "
                    "layer mappings, then reduce minimum path length or adjust vectorization "
                    "settings if geometry was removed."
                ),
                blocking=True,
            )
        )
    plan = PlotPlan(
        project_id=recipe.project_id,
        page=recipe.page,
        passes=passes,
        travel_segments=travel_segments,
        actions=actions,
        statistics=statistics,
        warnings=warnings,
        removed_geometry=removed,
        source_design_sha256=design.metadata.normalized_sha256,
    )
    return plan.model_copy(update={"normalized_sha256": canonical_sha256(plan)})
