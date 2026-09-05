from __future__ import annotations

import math
from itertools import zip_longest

from plotter_core.models import (
    GcodeInstruction,
    GcodeValidationReport,
    MachineProfile,
    PlannedPath,
    Point,
    ReconstructedToolpath,
    ValidationIssue,
)
from plotter_core.planning import distance


def _export_point(point: Point, profile: MachineProfile) -> Point:
    return Point(
        x=profile.work_width_mm - point.x if profile.invert_x else point.x,
        y=profile.work_height_mm - point.y if profile.invert_y else point.y,
    )


def validate_profile_for_page(
    profile: MachineProfile, page_width_mm: float, page_height_mm: float
) -> None:
    if page_width_mm > profile.work_width_mm or page_height_mm > profile.work_height_mm:
        raise ValueError(
            "The page does not fit inside the configured export work area "
            f"({profile.work_width_mm:g} x {profile.work_height_mm:g} mm)."
        )
    if profile.park.enabled and not (
        0 <= profile.park.x_mm <= page_width_mm and 0 <= profile.park.y_mm <= page_height_mm
    ):
        raise ValueError("The configured park position lies outside the page.")


def _compare_paths(
    expected_paths: list[PlannedPath],
    reconstructed: ReconstructedToolpath,
    profile: MachineProfile,
    tolerance: float,
) -> tuple[float, list[ValidationIssue]]:
    issues: list[ValidationIssue] = []
    maximum_error = 0.0
    expected_strokes = [
        (index, path) for index, path in enumerate(expected_paths) if path.kind == "stroke"
    ]
    expected_dots = [
        (index, path) for index, path in enumerate(expected_paths) if path.kind == "dot"
    ]
    if len(expected_strokes) != len(reconstructed.draw_paths):
        issues.append(
            ValidationIssue(
                code="path-count-mismatch",
                message=(
                    f"planned {len(expected_strokes)} draw paths but reconstructed "
                    f"{len(reconstructed.draw_paths)}"
                ),
                blocking=True,
            )
        )
    for expected_item, actual in zip_longest(expected_strokes, reconstructed.draw_paths):
        if expected_item is None or actual is None:
            continue
        path_index, expected = expected_item
        expected_points = [_export_point(point, profile) for point in expected.points]
        if len(expected_points) != len(actual):
            issues.append(
                ValidationIssue(
                    code="vertex-count-mismatch",
                    message=(
                        f"path {path_index} planned {len(expected_points)} points but "
                        f"reconstructed {len(actual)}"
                    ),
                    blocking=True,
                )
            )
        for expected_point, actual_point in zip(expected_points, actual, strict=False):
            error = distance(expected_point, actual_point)
            maximum_error = max(maximum_error, error)
        if any(
            distance(expected_point, actual_point) > tolerance
            for expected_point, actual_point in zip(expected_points, actual, strict=False)
        ):
            issues.append(
                ValidationIssue(
                    code="xy-round-trip-mismatch",
                    message=f"path {path_index} differs from the PlotPlan beyond tolerance",
                    blocking=True,
                )
            )
    if len(expected_dots) != len(reconstructed.draw_dots):
        issues.append(
            ValidationIssue(
                code="dot-count-mismatch",
                message=(
                    f"planned {len(expected_dots)} pen dots but reconstructed "
                    f"{len(reconstructed.draw_dots)}"
                ),
                blocking=True,
            )
        )
    for expected_item, actual in zip_longest(expected_dots, reconstructed.draw_dots):
        if expected_item is None or actual is None:
            continue
        path_index, expected = expected_item
        expected_point = _export_point(expected.points[0], profile)
        error = distance(expected_point, actual)
        maximum_error = max(maximum_error, error)
        if error > tolerance:
            issues.append(
                ValidationIssue(
                    code="dot-round-trip-mismatch",
                    message=f"dot path {path_index} differs from the PlotPlan beyond tolerance",
                    blocking=True,
                )
            )
    return maximum_error, issues


def validate_program(
    instructions: list[GcodeInstruction],
    reconstructed: ReconstructedToolpath,
    profile: MachineProfile,
    expected_paths: list[PlannedPath],
    tolerance_mm: float,
) -> GcodeValidationReport:
    issues: list[ValidationIssue] = []
    allowed = set(profile.allowed_commands)
    for instruction in instructions:
        if instruction.command not in allowed:
            issues.append(
                ValidationIssue(
                    code="unsupported-command",
                    message=(
                        f"line {instruction.line_number}: {instruction.command} is not allowlisted"
                    ),
                    blocking=True,
                )
            )
        for value in instruction.parameters.values():
            if not math.isfinite(value):
                issues.append(
                    ValidationIssue(
                        code="non-finite-value",
                        message=f"line {instruction.line_number}: non-finite numeric value",
                        blocking=True,
                    )
                )

    motion_index = next(
        (index for index, item in enumerate(instructions) if item.command in {"G0", "G1"}), None
    )
    if motion_index is not None:
        before_motion = {item.command for item in instructions[:motion_index]}
        if not {"G21", "G90"}.issubset(before_motion):
            issues.append(
                ValidationIssue(
                    code="modal-setup-missing",
                    message="G21 and G90 must be established before the first motion",
                    blocking=True,
                )
            )
        first_motion = instructions[motion_index]
        first_z = first_motion.parameters.get("Z")
        if (
            first_z is None
            or abs(first_z - profile.pen_actuator.up_mm) > tolerance_mm
            or "X" in first_motion.parameters
            or "Y" in first_motion.parameters
        ):
            issues.append(
                ValidationIssue(
                    code="missing-initial-pen-up",
                    message="the first motion must explicitly establish pen-up before XY motion",
                    blocking=True,
                )
            )

    for segment in reconstructed.segments:
        for point in (segment.start, segment.end):
            if not (
                -tolerance_mm <= point.x <= profile.work_width_mm + tolerance_mm
                and -tolerance_mm <= point.y <= profile.work_height_mm + tolerance_mm
            ):
                issues.append(
                    ValidationIssue(
                        code="out-of-bounds",
                        message=f"motion reaches ({point.x:.3f}, {point.y:.3f}) outside work area",
                        blocking=True,
                    )
                )
    if abs(reconstructed.final_z_mm - profile.pen_actuator.up_mm) > tolerance_mm:
        issues.append(
            ValidationIssue(
                code="missing-final-pen-up",
                message="the reconstructed final state is not pen-up",
                blocking=True,
            )
        )
    max_error, comparison_issues = _compare_paths(
        expected_paths, reconstructed, profile, tolerance_mm
    )
    issues.extend(comparison_issues)
    return GcodeValidationReport(
        valid=not any(issue.blocking for issue in issues),
        tolerance_mm=tolerance_mm,
        max_xy_error_mm=max_error,
        issues=issues,
    )
