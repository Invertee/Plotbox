from __future__ import annotations

import re

from plotter_core.models import MachineProfile, PlannedPath, PlotPass, PlotPlan, Point


def _format_number(value: float, precision: int) -> str:
    rendered = f"{value:.{precision}f}"
    if rendered.startswith("-0") and abs(value) < 0.5 * 10 ** (-precision):
        return rendered[1:]
    return rendered


def _slug(value: str) -> str:
    candidate = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return candidate or "pass"


class FluidncZWriter:
    """Conservative export-only FluidNC/Grbl writer for a Z-axis pen."""

    def __init__(self, profile: MachineProfile, project_name: str) -> None:
        self.profile = profile
        self.project_name = project_name

    def _xy(self, point: Point) -> tuple[float, float]:
        x = self.profile.work_width_mm - point.x if self.profile.invert_x else point.x
        y = self.profile.work_height_mm - point.y if self.profile.invert_y else point.y
        return x, y

    def _pen_up(self) -> list[str]:
        actuator = self.profile.pen_actuator
        lines = [
            f"G1 Z{_format_number(actuator.up_mm, self.profile.precision_decimals)} "
            f"F{_format_number(actuator.lift_feed_mm_min, 0)}"
        ]
        if actuator.dwell_after_up_ms:
            lines.append(f"G4 P{actuator.dwell_after_up_ms}")
        return lines

    def _pen_down(self, override: float | None = None) -> list[str]:
        actuator = self.profile.pen_actuator
        down_mm = actuator.down_mm if override is None else override
        if not actuator.down_mm <= down_mm < actuator.up_mm:
            raise ValueError(
                "per-pass pen-down override must be at or above the profile down value "
                "and below the pen-up value"
            )
        lines = [
            f"G1 Z{_format_number(down_mm, self.profile.precision_decimals)} "
            f"F{_format_number(actuator.lower_feed_mm_min, 0)}"
        ]
        if actuator.dwell_after_down_ms:
            lines.append(f"G4 P{actuator.dwell_after_down_ms}")
        return lines

    def _travel(self, point: Point) -> str:
        x, y = self._xy(point)
        precision = self.profile.precision_decimals
        return (
            f"G0 X{_format_number(x, precision)} Y{_format_number(y, precision)} "
            f"F{_format_number(self.profile.motion.travel_feed_mm_min, 0)}"
        )

    def _draw(self, point: Point, feed: float) -> str:
        x, y = self._xy(point)
        precision = self.profile.precision_decimals
        return (
            f"G1 X{_format_number(x, precision)} Y{_format_number(y, precision)} "
            f"F{_format_number(feed, 0)}"
        )

    def _header(self, title: str) -> list[str]:
        return [
            "; Plotbox export - files only; no machine connection",
            f"; Project: {self.project_name}",
            f"; {title}",
            *self.profile.macros.header,
            "",
            "; pen up",
            *self._pen_up(),
        ]

    def _footer(self) -> list[str]:
        return ["", "; final pen up", *self._pen_up(), *self.profile.macros.footer]

    def _draw_paths(
        self,
        paths: list[PlannedPath],
        feed: float,
        pen_down_override: float | None = None,
    ) -> list[str]:
        lines: list[str] = []
        for path in paths:
            lines.extend(
                [
                    "",
                    f"; path {path.path_id}",
                    self._travel(path.points[0]),
                    *self._pen_down(pen_down_override),
                ]
            )
            lines.extend(self._draw(point, feed) for point in path.points[1:])
            lines.extend(self._pen_up())
        return lines

    def pass_program(self, plot_pass: PlotPass) -> str:
        lines = self._header(f"Pass: {plot_pass.name}")
        lines.extend(
            self._draw_paths(
                plot_pass.ordered_paths,
                plot_pass.draw_feed_mm_min,
                plot_pass.pen_down_override,
            )
        )
        lines.extend(self._footer())
        return "\n".join(lines) + "\n"

    def combined_program(self, passes: list[PlotPass]) -> str:
        lines = self._header("Combined passes")
        for index, plot_pass in enumerate(passes):
            lines.extend(["", f"; begin pass {index + 1}: {plot_pass.name}"])
            lines.extend(
                self._draw_paths(
                    plot_pass.ordered_paths,
                    plot_pass.draw_feed_mm_min,
                    plot_pass.pen_down_override,
                )
            )
            if index < len(passes) - 1:
                lines.extend(["", "; pen change", *self._pen_up()])
                if self.profile.park.enabled:
                    lines.append(
                        self._travel(Point(x=self.profile.park.x_mm, y=self.profile.park.y_mm))
                    )
                message = f"CHANGE PEN TO {passes[index + 1].name.upper()}"
                lines.append(self.profile.macros.pause.format(message=message))
        lines.extend(self._footer())
        return "\n".join(lines) + "\n"

    def dry_run_program(self, plan: PlotPlan) -> str:
        lines = self._header("Dry run — pen remains up")
        for plot_pass in plan.passes:
            lines.append(f"; pass {plot_pass.name}")
            for path in plot_pass.ordered_paths:
                lines.append(self._travel(path.points[0]))
                lines.extend(self._travel(point) for point in path.points[1:])
        lines.extend(self._footer())
        return "\n".join(lines) + "\n"

    def boundary_program(self, plan: PlotPlan) -> str:
        page = plan.page
        corners = [
            Point(x=0.0, y=0.0),
            Point(x=page.width_mm, y=0.0),
            Point(x=page.width_mm, y=page.height_mm),
            Point(x=0.0, y=page.height_mm),
            Point(x=0.0, y=0.0),
        ]
        lines = self._header("Page boundary — pen remains up")
        lines.extend(self._travel(point) for point in corners)
        lines.extend(self._footer())
        return "\n".join(lines) + "\n"


def pass_filename(index: int, plot_pass: PlotPass) -> str:
    return f"{index:02d}-{_slug(plot_pass.name)}.nc"
