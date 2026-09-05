from __future__ import annotations

import math
from typing import Literal

from plotter_core.models import StrictModel
from pydantic import Field, model_validator

FluidNCCommissioningTestId = Literal[
    "scale_grid",
    "circle_arc",
    "diagonal_skew",
    "backlash_ladder",
    "speed_test",
    "z_depth_ladder",
    "lift_delay",
    "registration",
    "pen_swatch",
    "line_spacing",
    "hatch_density",
]

MAX_TEST_COMMANDS = 800
COORDINATE_LIMIT_MM = 500.0


class FluidNCCommissioningTestRequest(StrictModel):
    """Validated parameters for one fixed, bounded machine calibration pattern."""

    test_id: FluidNCCommissioningTestId
    origin_x_mm: float = Field(default=20.0, ge=-COORDINATE_LIMIT_MM, le=COORDINATE_LIMIT_MM)
    origin_y_mm: float = Field(default=20.0, ge=-COORDINATE_LIMIT_MM, le=COORDINATE_LIMIT_MM)
    width_mm: float = Field(default=100.0, gt=1.0, le=180.0)
    height_mm: float = Field(default=100.0, gt=1.0, le=180.0)
    feed_mm_min: float = Field(default=600.0, ge=60.0, le=3_000.0)
    speed_start_mm_min: float = Field(default=300.0, ge=60.0, le=3_000.0)
    speed_end_mm_min: float = Field(default=1_800.0, ge=60.0, le=3_000.0)
    spacing_mm: float = Field(default=8.0, ge=0.5, le=20.0)
    step_mm: float = Field(default=5.0, ge=0.1, le=25.0)
    steps: int = Field(default=5, ge=2, le=12)
    z_up_mm: float = Field(default=5.0, ge=-20.0, le=20.0)
    z_down_mm: float = Field(default=0.0, ge=-20.0, le=20.0)
    depth_start_mm: float = Field(default=0.0, ge=-20.0, le=20.0)
    depth_end_mm: float = Field(default=-1.0, ge=-20.0, le=20.0)
    delay_step_ms: int = Field(default=100, ge=0, le=2_000)

    @model_validator(mode="after")
    def validate_area_and_z_values(self) -> FluidNCCommissioningTestRequest:
        numeric_values = (
            self.origin_x_mm,
            self.origin_y_mm,
            self.width_mm,
            self.height_mm,
            self.feed_mm_min,
            self.speed_start_mm_min,
            self.speed_end_mm_min,
            self.spacing_mm,
            self.step_mm,
            self.z_up_mm,
            self.z_down_mm,
            self.depth_start_mm,
            self.depth_end_mm,
        )
        if not all(math.isfinite(value) for value in numeric_values):
            raise ValueError("commissioning test values must be finite")
        if self.origin_x_mm + self.width_mm > COORDINATE_LIMIT_MM:
            raise ValueError("test area exceeds the positive X commissioning bound")
        if self.origin_y_mm + self.height_mm > COORDINATE_LIMIT_MM:
            raise ValueError("test area exceeds the positive Y commissioning bound")
        if self.z_up_mm <= self.z_down_mm:
            raise ValueError("pen-up Z must be above pen-down Z")
        if (
            self.test_id == "z_depth_ladder"
            and max(self.depth_start_mm, self.depth_end_mm) > self.z_up_mm
        ):
            raise ValueError("Z-depth ladder values must remain below pen-up Z")
        return self


def build_commissioning_test_frames(
    request: FluidNCCommissioningTestRequest,
) -> tuple[list[str], list[str]]:
    commands = [
        "G21",
        "G90",
        "G17",
        "G94",
        _z_move(request.z_up_mm, request.feed_mm_min),
    ]
    builders = {
        "scale_grid": _build_scale_grid,
        "circle_arc": _build_circle_arc,
        "diagonal_skew": _build_diagonal_skew,
        "backlash_ladder": _build_backlash_ladder,
        "speed_test": _build_speed_test,
        "z_depth_ladder": _build_z_depth_ladder,
        "lift_delay": _build_lift_delay,
        "registration": _build_registration,
        "pen_swatch": _build_pen_swatch,
        "line_spacing": _build_line_spacing,
        "hatch_density": _build_hatch_density,
    }
    commands.extend(builders[request.test_id](request))
    commands.append(_z_move(request.z_up_mm, request.feed_mm_min))
    if len(commands) > MAX_TEST_COMMANDS:
        raise ValueError(
            f"{request.test_id} exceeds the {MAX_TEST_COMMANDS}-command commissioning budget"
        )
    return [f"{command}\n" for command in commands], [request.test_id, f"{len(commands)} commands"]


def _build_scale_grid(request: FluidNCCommissioningTestRequest) -> list[str]:
    commands: list[str] = []
    x0, y0, x1, y1 = _area(request)
    spacing = request.spacing_mm
    y = y0
    while y <= y1 + 1e-9:
        commands.extend(_stroke(request, [(x0, y), (x1, y)]))
        y += spacing
    x = x0
    while x <= x1 + 1e-9:
        commands.extend(_stroke(request, [(x, y0), (x, y1)]))
        x += spacing
    return commands


def _build_circle_arc(request: FluidNCCommissioningTestRequest) -> list[str]:
    x0, y0, x1, y1 = _area(request)
    radius = min(request.width_mm, request.height_mm) / 6.0
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    start = (cx + radius, cy)
    commands = _arc_stroke(
        request,
        start,
        f"G2 X{_number(start[0])} Y{_number(start[1])} "
        f"I-{_number(radius)} J0 F{_number(request.feed_mm_min)}",
    )

    arc_centres = (
        (x0 + request.width_mm * 0.25, y0 + request.height_mm * 0.25),
        (x0 + request.width_mm * 0.75, y0 + request.height_mm * 0.25),
        (x0 + request.width_mm * 0.25, y0 + request.height_mm * 0.75),
        (x0 + request.width_mm * 0.75, y0 + request.height_mm * 0.75),
    )
    for index, (arc_x, arc_y) in enumerate(arc_centres):
        arc_start = (arc_x + radius, arc_y)
        arc_end = (arc_x, arc_y + radius)
        command = (
            f"G3 X{_number(arc_end[0])} Y{_number(arc_end[1])} "
            f"I-{_number(radius)} J0 F{_number(request.feed_mm_min)}"
        )
        if index % 2:
            arc_start = (arc_x, arc_y + radius)
            arc_end = (arc_x - radius, arc_y)
            command = (
                f"G3 X{_number(arc_end[0])} Y{_number(arc_end[1])} "
                f"I0 J-{_number(radius)} F{_number(request.feed_mm_min)}"
            )
        commands.extend(_arc_stroke(request, arc_start, command))
    return commands


def _build_diagonal_skew(request: FluidNCCommissioningTestRequest) -> list[str]:
    x0, y0, x1, y1 = _area(request)
    inset = min(request.width_mm, request.height_mm) * 0.08
    return [
        *_stroke(request, [(x0 + inset, y0 + inset), (x1 - inset, y1 - inset)]),
        *_stroke(request, [(x0 + inset, y1 - inset), (x1 - inset, y0 + inset)]),
        *_stroke(request, [(x0, y0), (x1, y0)]),
        *_stroke(request, [(x0, y0), (x0, y1)]),
    ]


def _build_backlash_ladder(request: FluidNCCommissioningTestRequest) -> list[str]:
    commands: list[str] = []
    x0, y0, x1, y1 = _area(request)
    row_step = min(request.step_mm, request.height_mm / max(request.steps, 2))
    for index in range(request.steps):
        y = y0 + row_step * (index + 1)
        points = [(x0, y), (x1, y)] if index % 2 == 0 else [(x1, y), (x0, y)]
        commands.extend(_stroke(request, points))
    column_step = min(request.step_mm, request.width_mm / max(request.steps, 2))
    for index in range(request.steps):
        x = x0 + column_step * (index + 1)
        points = [(x, y0), (x, y1)] if index % 2 == 0 else [(x, y1), (x, y0)]
        commands.extend(_stroke(request, points))
    return commands


def _build_speed_test(request: FluidNCCommissioningTestRequest) -> list[str]:
    commands: list[str] = []
    x0, y0, x1, _ = _area(request)
    row_spacing = request.height_mm / (request.steps + 1)
    for index in range(request.steps):
        fraction = index / max(request.steps - 1, 1)
        feed = (
            request.speed_start_mm_min
            + (request.speed_end_mm_min - request.speed_start_mm_min) * fraction
        )
        y = y0 + row_spacing * (index + 1)
        commands.extend(_stroke(request, [(x0, y), (x1, y)], feed=feed))
    return commands


def _build_z_depth_ladder(request: FluidNCCommissioningTestRequest) -> list[str]:
    commands: list[str] = []
    x0, y0, x1, _ = _area(request)
    row_spacing = request.height_mm / (request.steps + 1)
    for index in range(request.steps):
        fraction = index / max(request.steps - 1, 1)
        depth = request.depth_start_mm + (request.depth_end_mm - request.depth_start_mm) * fraction
        y = y0 + row_spacing * (index + 1)
        commands.extend(_stroke(request, [(x0, y), (x1, y)], down=depth))
    return commands


def _build_lift_delay(request: FluidNCCommissioningTestRequest) -> list[str]:
    commands: list[str] = []
    x0, y0, x1, _ = _area(request)
    row_spacing = request.height_mm / (request.steps + 1)
    for index in range(request.steps):
        y = y0 + row_spacing * (index + 1)
        commands.extend(
            _stroke(
                request,
                [(x0, y), (x1, y)],
                pre_down_delay_ms=index * request.delay_step_ms,
            )
        )
    return commands


def _build_registration(request: FluidNCCommissioningTestRequest) -> list[str]:
    commands: list[str] = []
    x0, y0, x1, y1 = _area(request)
    arm = min(request.width_mm, request.height_mm) * 0.06
    targets = (
        (x0 + arm, y0 + arm),
        (x1 - arm, y0 + arm),
        (x1 - arm, y1 - arm),
        (x0 + arm, y1 - arm),
        ((x0 + x1) / 2.0, (y0 + y1) / 2.0),
    )
    for x, y in targets:
        commands.extend(_stroke(request, [(x - arm, y), (x + arm, y)]))
        commands.extend(_stroke(request, [(x, y - arm), (x, y + arm)]))
    return commands


def _build_pen_swatch(request: FluidNCCommissioningTestRequest) -> list[str]:
    commands: list[str] = []
    x0, y0, _, _ = _area(request)
    gap = request.width_mm * 0.03
    swatch_width = (request.width_mm - gap * (request.steps - 1)) / request.steps
    swatch_height = request.height_mm * 0.6
    for index in range(request.steps):
        left = x0 + index * (swatch_width + gap)
        right = left + swatch_width
        bottom = y0 + (request.height_mm - swatch_height) / 2.0
        box = [
            (left, bottom),
            (right, bottom),
            (right, bottom + swatch_height),
            (left, bottom + swatch_height),
            (left, bottom),
        ]
        for _ in range(index + 1):
            commands.extend(_stroke(request, box))
    return commands


def _build_line_spacing(request: FluidNCCommissioningTestRequest) -> list[str]:
    commands: list[str] = []
    x0, y0, _, _ = _area(request)
    column_width = request.width_mm / request.steps
    for index in range(request.steps):
        left = x0 + index * column_width
        right = left + column_width * 0.9
        spacing = request.spacing_mm * (1.0 + index * 0.5)
        top = y0 + spacing * 3.0
        if top > y0 + request.height_mm:
            raise ValueError("line-spacing ladder needs a taller test area or smaller spacing")
        for line_index in range(4):
            y = y0 + line_index * spacing
            commands.extend(_stroke(request, [(left, y), (right, y)]))
    return commands


def _build_hatch_density(request: FluidNCCommissioningTestRequest) -> list[str]:
    commands: list[str] = []
    x0, y0, _, y1 = _area(request)
    gap = request.width_mm * 0.03
    block_width = (request.width_mm - gap * (request.steps - 1)) / request.steps
    for index in range(request.steps):
        left = x0 + index * (block_width + gap)
        right = left + block_width
        bottom = y0 + request.height_mm * 0.15
        top = y1 - request.height_mm * 0.15
        commands.extend(
            _stroke(
                request,
                [(left, bottom), (right, bottom), (right, top), (left, top), (left, bottom)],
            )
        )
        spacing = request.spacing_mm / (index + 1)
        y = bottom + spacing
        while y < top - 1e-9:
            commands.extend(_stroke(request, [(left, y), (right, y)]))
            y += spacing
    return commands


def _area(request: FluidNCCommissioningTestRequest) -> tuple[float, float, float, float]:
    return (
        request.origin_x_mm,
        request.origin_y_mm,
        request.origin_x_mm + request.width_mm,
        request.origin_y_mm + request.height_mm,
    )


def _stroke(
    request: FluidNCCommissioningTestRequest,
    points: list[tuple[float, float]],
    *,
    feed: float | None = None,
    down: float | None = None,
    pre_down_delay_ms: int = 0,
) -> list[str]:
    if len(points) < 2:
        raise ValueError("calibration stroke requires at least two points")
    chosen_feed = feed if feed is not None else request.feed_mm_min
    chosen_down = down if down is not None else request.z_down_mm
    commands = [_xy_move(*points[0]), _z_move(chosen_down, chosen_feed)]
    commands.extend(_xy_draw(x, y, chosen_feed) for x, y in points[1:])
    commands.append(_z_move(request.z_up_mm, chosen_feed))
    if pre_down_delay_ms:
        commands.insert(1, f"G4 P{_number(pre_down_delay_ms / 1000)}")
    return commands


def _arc_stroke(
    request: FluidNCCommissioningTestRequest,
    start: tuple[float, float],
    arc_command: str,
) -> list[str]:
    return [
        _xy_move(*start),
        _z_move(request.z_down_mm, request.feed_mm_min),
        arc_command,
        _z_move(request.z_up_mm, request.feed_mm_min),
    ]


def _xy_move(x: float, y: float) -> str:
    return f"G0 X{_number(x)} Y{_number(y)}"


def _xy_draw(x: float, y: float, feed: float) -> str:
    return f"G1 X{_number(x)} Y{_number(y)} F{_number(feed)}"


def _z_move(z: float, feed: float) -> str:
    return f"G1 Z{_number(z)} F{_number(feed)}"


def _number(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")
