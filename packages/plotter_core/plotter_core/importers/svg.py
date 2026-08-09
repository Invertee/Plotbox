from __future__ import annotations

import hashlib
import math
import re
import xml.etree.ElementTree as ET
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from itertools import pairwise

from plotter_core.importers.fixture_font import text_outline_paths
from plotter_core.models import (
    CloseCommand,
    CubicCommand,
    DesignDiagnostic,
    DesignDocument,
    DesignLayer,
    DesignMetadata,
    DesignPath,
    LineCommand,
    MoveCommand,
    Point,
    ProjectRecipe,
    QuadraticCommand,
    canonical_sha256,
)
from plotter_core.planning import flatten_design_path

SVG_IMPORTER_ID = "import.svg"
SVG_IMPORTER_VERSION = "1.0.0"
MAX_SVG_BYTES = 25 * 1024 * 1024
MAX_SVG_NODES = 50_000
MAX_PATH_NUMBERS = 1_000_000

type Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1, 0, 0, 1, 0, 0)
NUMBER = r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
PATH_TOKEN_RE = re.compile(rf"[A-Za-z]|{NUMBER}")
TRANSFORM_RE = re.compile(r"([A-Za-z]+)\s*\(([^)]*)\)")
STYLE_KEYS = {
    "fill",
    "stroke",
    "stroke-width",
    "stroke-dasharray",
    "display",
    "visibility",
    "opacity",
    "font-size",
}
DRAWABLE_TAGS = {"path", "line", "polyline", "polygon", "rect", "circle", "ellipse", "text"}
UNSUPPORTED_TAGS = {
    "filter": "unsupported-filter",
    "mask": "unsupported-mask",
    "foreignObject": "unsupported-foreign-object",
    "script": "active-content-removed",
    "image": "external-or-raster-image",
    "style": "unsupported-css",
}


@dataclass
class _LayerBuilder:
    name: str
    role: str
    preview_color: str = "#171717"
    paths: list[DesignPath] | None = None

    def __post_init__(self) -> None:
        if self.paths is None:
            self.paths = []


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _multiply(left: Matrix, right: Matrix) -> Matrix:
    a1, b1, c1, d1, e1, f1 = left
    a2, b2, c2, d2, e2, f2 = right
    return (
        a1 * a2 + c1 * b2,
        b1 * a2 + d1 * b2,
        a1 * c2 + c1 * d2,
        b1 * c2 + d1 * d2,
        a1 * e2 + c1 * f2 + e1,
        b1 * e2 + d1 * f2 + f1,
    )


def _apply(matrix: Matrix, point: Point) -> Point:
    a, b, c, d, e, f = matrix
    return Point(x=a * point.x + c * point.y + e, y=b * point.x + d * point.y + f)


def _transform_matrix(value: str | None) -> Matrix:
    matrix = IDENTITY
    if not value:
        return matrix
    for match in TRANSFORM_RE.finditer(value):
        name = match.group(1).lower()
        values = [float(item) for item in re.findall(NUMBER, match.group(2))]
        operation = IDENTITY
        if name == "matrix" and len(values) == 6:
            operation = tuple(values)  # type: ignore[assignment]
        elif name == "translate" and values:
            operation = (1, 0, 0, 1, values[0], values[1] if len(values) > 1 else 0)
        elif name == "scale" and values:
            operation = (values[0], 0, 0, values[1] if len(values) > 1 else values[0], 0, 0)
        elif name == "rotate" and values:
            angle = math.radians(values[0])
            rotation = (
                math.cos(angle),
                math.sin(angle),
                -math.sin(angle),
                math.cos(angle),
                0,
                0,
            )
            if len(values) >= 3:
                cx, cy = values[1:3]
                operation = _multiply(
                    _multiply((1, 0, 0, 1, cx, cy), rotation),
                    (1, 0, 0, 1, -cx, -cy),
                )
            else:
                operation = rotation
        elif name == "skewx" and values:
            operation = (1, 0, math.tan(math.radians(values[0])), 1, 0, 0)
        elif name == "skewy" and values:
            operation = (1, math.tan(math.radians(values[0])), 0, 1, 0, 0)
        matrix = _multiply(matrix, operation)
    return matrix


def _length_mm(value: str | None, *, default: float) -> float:
    if not value:
        return default
    match = re.fullmatch(rf"\s*({NUMBER})\s*([A-Za-z%]*)\s*", value)
    if match is None:
        raise ValueError(f"invalid SVG length: {value!r}")
    number = float(match.group(1))
    unit = match.group(2).lower()
    factors = {
        "": 25.4 / 96,
        "px": 25.4 / 96,
        "mm": 1.0,
        "cm": 10.0,
        "in": 25.4,
        "pt": 25.4 / 72,
        "pc": 25.4 / 6,
    }
    if unit not in factors:
        raise ValueError(f"unsupported SVG length unit: {unit or '(none)'}")
    return number * factors[unit]


def _number(value: str | None, default: float = 0.0) -> float:
    if value is None:
        return default
    match = re.match(NUMBER, value.strip())
    return float(match.group(0)) if match else default


def _slug(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:64] or "svg"


def _style(element: ET.Element, inherited: dict[str, str]) -> dict[str, str]:
    result = dict(inherited)
    for key in STYLE_KEYS:
        if key in element.attrib:
            result[key] = element.attrib[key]
    inline = element.attrib.get("style", "")
    for declaration in inline.split(";"):
        if ":" not in declaration:
            continue
        key, value = (part.strip() for part in declaration.split(":", 1))
        if key in STYLE_KEYS:
            result[key] = value
    return result


def _layer_name(element: ET.Element) -> str:
    label = next(
        (value for key, value in element.attrib.items() if key.endswith("}label")),
        None,
    )
    return label or element.attrib.get("id") or "SVG"


def _transform_path(path: DesignPath, matrix: Matrix) -> DesignPath:
    commands: list[MoveCommand | LineCommand | QuadraticCommand | CubicCommand | CloseCommand] = []
    for command in path.commands:
        if isinstance(command, MoveCommand):
            commands.append(MoveCommand(point=_apply(matrix, command.point)))
        elif isinstance(command, LineCommand):
            commands.append(LineCommand(point=_apply(matrix, command.point)))
        elif isinstance(command, QuadraticCommand):
            commands.append(
                QuadraticCommand(
                    control=_apply(matrix, command.control),
                    point=_apply(matrix, command.point),
                )
            )
        elif isinstance(command, CubicCommand):
            commands.append(
                CubicCommand(
                    control1=_apply(matrix, command.control1),
                    control2=_apply(matrix, command.control2),
                    point=_apply(matrix, command.point),
                )
            )
        else:
            commands.append(command)
    return path.model_copy(update={"commands": commands})


def _shape_paths(
    element: ET.Element,
    path_prefix: str,
    style: dict[str, str] | None = None,
) -> list[DesignPath]:
    tag = _local_name(element.tag)
    if tag == "text":
        return text_outline_paths(
            "".join(element.itertext()),
            x=_number(element.get("x")),
            baseline_y=_number(element.get("y")),
            font_size=max(1.0, _number((style or {}).get("font-size"), 16.0)),
            prefix=path_prefix,
        )
    if tag == "path":
        return _parse_path_data(element.attrib.get("d", ""), path_prefix)
    if tag == "line":
        return [
            DesignPath(
                path_id=path_prefix,
                commands=[
                    MoveCommand(
                        point=Point(x=_number(element.get("x1")), y=_number(element.get("y1")))
                    ),
                    LineCommand(
                        point=Point(x=_number(element.get("x2")), y=_number(element.get("y2")))
                    ),
                ],
            )
        ]
    if tag in {"polyline", "polygon"}:
        values = [float(item) for item in re.findall(NUMBER, element.get("points", ""))]
        points = [
            Point(x=values[index], y=values[index + 1]) for index in range(0, len(values) - 1, 2)
        ]
        if len(points) < 2:
            return []
        closed = tag == "polygon"
        poly_commands: list[MoveCommand | LineCommand | CloseCommand] = [
            MoveCommand(point=points[0]),
            *(LineCommand(point=point) for point in points[1:]),
        ]
        if closed:
            poly_commands.append(CloseCommand())
        return [DesignPath(path_id=path_prefix, commands=poly_commands, closed=closed)]
    if tag == "rect":
        x, y = _number(element.get("x")), _number(element.get("y"))
        width, height = _number(element.get("width")), _number(element.get("height"))
        if width <= 0 or height <= 0:
            return []
        rx = min(_number(element.get("rx")), width / 2)
        ry = min(_number(element.get("ry"), rx), height / 2)
        rect_commands: list[
            MoveCommand | LineCommand | QuadraticCommand | CubicCommand | CloseCommand
        ]
        if rx <= 0 or ry <= 0:
            rect_commands = [
                MoveCommand(point=Point(x=x, y=y)),
                LineCommand(point=Point(x=x + width, y=y)),
                LineCommand(point=Point(x=x + width, y=y + height)),
                LineCommand(point=Point(x=x, y=y + height)),
                CloseCommand(),
            ]
        else:
            kappa = 0.5522847498307936
            rect_commands = [
                MoveCommand(point=Point(x=x + rx, y=y)),
                LineCommand(point=Point(x=x + width - rx, y=y)),
                CubicCommand(
                    control1=Point(x=x + width - rx + kappa * rx, y=y),
                    control2=Point(x=x + width, y=y + ry - kappa * ry),
                    point=Point(x=x + width, y=y + ry),
                ),
                LineCommand(point=Point(x=x + width, y=y + height - ry)),
                CubicCommand(
                    control1=Point(x=x + width, y=y + height - ry + kappa * ry),
                    control2=Point(x=x + width - rx + kappa * rx, y=y + height),
                    point=Point(x=x + width - rx, y=y + height),
                ),
                LineCommand(point=Point(x=x + rx, y=y + height)),
                CubicCommand(
                    control1=Point(x=x + rx - kappa * rx, y=y + height),
                    control2=Point(x=x, y=y + height - ry + kappa * ry),
                    point=Point(x=x, y=y + height - ry),
                ),
                LineCommand(point=Point(x=x, y=y + ry)),
                CubicCommand(
                    control1=Point(x=x, y=y + ry - kappa * ry),
                    control2=Point(x=x + rx - kappa * rx, y=y),
                    point=Point(x=x + rx, y=y),
                ),
                CloseCommand(),
            ]
        return [DesignPath(path_id=path_prefix, commands=rect_commands, closed=True)]
    if tag in {"circle", "ellipse"}:
        cx, cy = _number(element.get("cx")), _number(element.get("cy"))
        rx = _number(element.get("r")) if tag == "circle" else _number(element.get("rx"))
        ry = rx if tag == "circle" else _number(element.get("ry"))
        if rx <= 0 or ry <= 0:
            return []
        kappa = 0.5522847498307936
        ellipse_commands: list[
            MoveCommand | LineCommand | QuadraticCommand | CubicCommand | CloseCommand
        ] = [
            MoveCommand(point=Point(x=cx + rx, y=cy)),
            CubicCommand(
                control1=Point(x=cx + rx, y=cy + kappa * ry),
                control2=Point(x=cx + kappa * rx, y=cy + ry),
                point=Point(x=cx, y=cy + ry),
            ),
            CubicCommand(
                control1=Point(x=cx - kappa * rx, y=cy + ry),
                control2=Point(x=cx - rx, y=cy + kappa * ry),
                point=Point(x=cx - rx, y=cy),
            ),
            CubicCommand(
                control1=Point(x=cx - rx, y=cy - kappa * ry),
                control2=Point(x=cx - kappa * rx, y=cy - ry),
                point=Point(x=cx, y=cy - ry),
            ),
            CubicCommand(
                control1=Point(x=cx + kappa * rx, y=cy - ry),
                control2=Point(x=cx + rx, y=cy - kappa * ry),
                point=Point(x=cx + rx, y=cy),
            ),
            CloseCommand(),
        ]
        return [DesignPath(path_id=path_prefix, commands=ellipse_commands, closed=True)]
    return []


def _parse_path_data(data: str, path_prefix: str) -> list[DesignPath]:
    tokens = PATH_TOKEN_RE.findall(data.replace(",", " "))
    if len(tokens) > MAX_PATH_NUMBERS:
        raise ValueError("SVG path data exceeds the numeric token limit")
    paths: list[DesignPath] = []
    index = 0
    command = ""
    current = Point(x=0, y=0)
    start = current
    last_cubic: Point | None = None
    last_quadratic: Point | None = None
    commands: list[MoveCommand | LineCommand | QuadraticCommand | CubicCommand | CloseCommand] = []

    def take(count: int) -> list[float]:
        nonlocal index
        if index + count > len(tokens) or any(
            tokens[position].isalpha() for position in range(index, index + count)
        ):
            raise ValueError("malformed SVG path data")
        values = [float(tokens[position]) for position in range(index, index + count)]
        index += count
        return values

    def absolute(x: float, y: float, relative: bool) -> Point:
        return Point(x=current.x + x, y=current.y + y) if relative else Point(x=x, y=y)

    def finish(closed: bool = False) -> None:
        nonlocal commands
        if len(commands) >= 2:
            paths.append(
                DesignPath(
                    path_id=f"{path_prefix}-{len(paths) + 1}",
                    commands=commands,
                    closed=closed,
                )
            )
        commands = []

    while index < len(tokens):
        if tokens[index].isalpha():
            command = tokens[index]
            index += 1
        if not command:
            raise ValueError("SVG path data must begin with a command")
        relative = command.islower()
        kind = command.upper()
        if kind == "M":
            x, y = take(2)
            point = absolute(x, y, relative)
            if commands:
                finish()
            commands = [MoveCommand(point=point)]
            current = start = point
            command = "l" if relative else "L"
        elif kind == "L":
            x, y = take(2)
            current = absolute(x, y, relative)
            commands.append(LineCommand(point=current))
        elif kind == "H":
            (x,) = take(1)
            current = Point(x=current.x + x if relative else x, y=current.y)
            commands.append(LineCommand(point=current))
        elif kind == "V":
            (y,) = take(1)
            current = Point(x=current.x, y=current.y + y if relative else y)
            commands.append(LineCommand(point=current))
        elif kind == "C":
            x1, y1, x2, y2, x, y = take(6)
            control1 = absolute(x1, y1, relative)
            control2 = absolute(x2, y2, relative)
            end = absolute(x, y, relative)
            commands.append(CubicCommand(control1=control1, control2=control2, point=end))
            current, last_cubic = end, control2
        elif kind == "S":
            x2, y2, x, y = take(4)
            control1 = (
                Point(x=2 * current.x - last_cubic.x, y=2 * current.y - last_cubic.y)
                if last_cubic is not None
                else current
            )
            control2 = absolute(x2, y2, relative)
            end = absolute(x, y, relative)
            commands.append(CubicCommand(control1=control1, control2=control2, point=end))
            current, last_cubic = end, control2
        elif kind == "Q":
            x1, y1, x, y = take(4)
            control = absolute(x1, y1, relative)
            end = absolute(x, y, relative)
            commands.append(QuadraticCommand(control=control, point=end))
            current, last_quadratic = end, control
        elif kind == "T":
            x, y = take(2)
            control = (
                Point(
                    x=2 * current.x - last_quadratic.x,
                    y=2 * current.y - last_quadratic.y,
                )
                if last_quadratic is not None
                else current
            )
            end = absolute(x, y, relative)
            commands.append(QuadraticCommand(control=control, point=end))
            current, last_quadratic = end, control
        elif kind == "A":
            rx, ry, rotation, large, sweep, x, y = take(7)
            end = absolute(x, y, relative)
            cubics = _arc_cubics(current, end, rx, ry, rotation, bool(large), bool(sweep))
            commands.extend(cubics if cubics else [LineCommand(point=end)])
            current = end
        elif kind == "Z":
            commands.append(CloseCommand())
            current = start
            finish(closed=True)
            command = ""
        else:
            raise ValueError(f"unsupported SVG path command: {command}")
        if kind not in {"C", "S"}:
            last_cubic = None
        if kind not in {"Q", "T"}:
            last_quadratic = None
    finish()
    return paths


def _arc_cubics(
    start: Point,
    end: Point,
    rx: float,
    ry: float,
    rotation_degrees: float,
    large_arc: bool,
    sweep: bool,
) -> list[CubicCommand]:
    rx, ry = abs(rx), abs(ry)
    if rx == 0 or ry == 0 or start == end:
        return []
    phi = math.radians(rotation_degrees % 360)
    cos_phi, sin_phi = math.cos(phi), math.sin(phi)
    dx, dy = (start.x - end.x) / 2, (start.y - end.y) / 2
    x1 = cos_phi * dx + sin_phi * dy
    y1 = -sin_phi * dx + cos_phi * dy
    scale = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry)
    if scale > 1:
        factor = math.sqrt(scale)
        rx *= factor
        ry *= factor
    numerator = max(0.0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1)
    denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
    coefficient = 0.0 if denominator == 0 else math.sqrt(numerator / denominator)
    if large_arc == sweep:
        coefficient = -coefficient
    cx1 = coefficient * (rx * y1 / ry)
    cy1 = coefficient * (-ry * x1 / rx)
    cx = cos_phi * cx1 - sin_phi * cy1 + (start.x + end.x) / 2
    cy = sin_phi * cx1 + cos_phi * cy1 + (start.y + end.y) / 2

    def angle(u: tuple[float, float], v: tuple[float, float]) -> float:
        dot = u[0] * v[0] + u[1] * v[1]
        length = math.hypot(*u) * math.hypot(*v)
        value = max(-1.0, min(1.0, dot / length)) if length else 1.0
        result = math.acos(value)
        return -result if u[0] * v[1] - u[1] * v[0] < 0 else result

    theta = angle((1, 0), ((x1 - cx1) / rx, (y1 - cy1) / ry))
    delta = angle(
        ((x1 - cx1) / rx, (y1 - cy1) / ry),
        ((-x1 - cx1) / rx, (-y1 - cy1) / ry),
    )
    if not sweep and delta > 0:
        delta -= 2 * math.pi
    if sweep and delta < 0:
        delta += 2 * math.pi
    count = max(1, math.ceil(abs(delta) / (math.pi / 2)))
    step = delta / count

    def point_at(value: float) -> Point:
        return Point(
            x=cx + rx * math.cos(value) * cos_phi - ry * math.sin(value) * sin_phi,
            y=cy + rx * math.cos(value) * sin_phi + ry * math.sin(value) * cos_phi,
        )

    result: list[CubicCommand] = []
    for segment in range(count):
        start_angle = theta + segment * step
        end_angle = start_angle + step
        alpha = 4 / 3 * math.tan(step / 4)
        p0, p3 = point_at(start_angle), point_at(end_angle)
        derivative0 = Point(
            x=-rx * math.sin(start_angle) * cos_phi - ry * math.cos(start_angle) * sin_phi,
            y=-rx * math.sin(start_angle) * sin_phi + ry * math.cos(start_angle) * cos_phi,
        )
        derivative1 = Point(
            x=-rx * math.sin(end_angle) * cos_phi - ry * math.cos(end_angle) * sin_phi,
            y=-rx * math.sin(end_angle) * sin_phi + ry * math.cos(end_angle) * cos_phi,
        )
        result.append(
            CubicCommand(
                control1=Point(x=p0.x + alpha * derivative0.x, y=p0.y + alpha * derivative0.y),
                control2=Point(x=p3.x - alpha * derivative1.x, y=p3.y - alpha * derivative1.y),
                point=p3,
            )
        )
    return result


def _polyline_path(path_id: str, points: list[Point]) -> DesignPath | None:
    if len(points) < 2:
        return None
    return DesignPath(
        path_id=path_id,
        commands=[
            MoveCommand(point=points[0]),
            *(LineCommand(point=point) for point in points[1:]),
        ],
    )


def _dash_paths(path: DesignPath, values: list[float]) -> list[DesignPath]:
    pattern = [value for value in values if value > 0]
    if not pattern:
        return [path]
    if len(pattern) % 2:
        pattern *= 2
    points = flatten_design_path(path, 0.08)
    result: list[DesignPath] = []
    pattern_index = 0
    remaining = pattern[0]
    drawing = True
    active: list[Point] = []
    for start, end in pairwise(points):
        dx, dy = end.x - start.x, end.y - start.y
        segment_length = math.hypot(dx, dy)
        consumed = 0.0
        while consumed < segment_length - 1e-12:
            step = min(remaining, segment_length - consumed)
            first = Point(
                x=start.x + dx * consumed / segment_length,
                y=start.y + dy * consumed / segment_length,
            )
            second = Point(
                x=start.x + dx * (consumed + step) / segment_length,
                y=start.y + dy * (consumed + step) / segment_length,
            )
            if drawing:
                if not active:
                    active = [first]
                active.append(second)
            consumed += step
            remaining -= step
            if remaining <= 1e-12:
                if drawing and len(active) >= 2:
                    dashed = _polyline_path(f"{path.path_id}-dash-{len(result) + 1}", active)
                    if dashed is not None:
                        result.append(dashed)
                    active = []
                pattern_index = (pattern_index + 1) % len(pattern)
                remaining = pattern[pattern_index]
                drawing = pattern_index % 2 == 0
    if drawing and len(active) >= 2:
        dashed = _polyline_path(f"{path.path_id}-dash-{len(result) + 1}", active)
        if dashed is not None:
            result.append(dashed)
    return result


def _offset_paths(path: DesignPath, offsets: Iterable[float], prefix: str) -> list[DesignPath]:
    points = flatten_design_path(path, 0.08)
    if len(points) < 2:
        return []
    result: list[DesignPath] = []
    for index, offset in enumerate(offsets):
        shifted: list[Point] = []
        for point_index, point in enumerate(points):
            before = points[max(0, point_index - 1)]
            after = points[min(len(points) - 1, point_index + 1)]
            dx, dy = after.x - before.x, after.y - before.y
            length = math.hypot(dx, dy)
            shifted.append(
                Point(
                    x=point.x - dy / length * offset if length else point.x,
                    y=point.y + dx / length * offset if length else point.y,
                )
            )
        converted = _polyline_path(f"{path.path_id}-{prefix}-{index + 1}", shifted)
        if converted is not None:
            result.append(converted)
    return result


def _hatch_paths(
    path: DesignPath,
    *,
    spacing: float,
    angle_degrees: float,
    prefix: str,
) -> list[DesignPath]:
    polygon = flatten_design_path(path, min(0.08, spacing / 5))
    if len(polygon) < 3:
        return []
    if polygon[0] != polygon[-1]:
        polygon.append(polygon[0])
    angle = math.radians(angle_degrees)
    cos_angle, sin_angle = math.cos(angle), math.sin(angle)

    def rotate(point: Point) -> Point:
        return Point(
            x=point.x * cos_angle + point.y * sin_angle,
            y=-point.x * sin_angle + point.y * cos_angle,
        )

    def unrotate(point: Point) -> Point:
        return Point(
            x=point.x * cos_angle - point.y * sin_angle,
            y=point.x * sin_angle + point.y * cos_angle,
        )

    rotated = [rotate(point) for point in polygon]
    minimum_y = min(point.y for point in rotated)
    maximum_y = max(point.y for point in rotated)
    scan_y = math.floor(minimum_y / spacing) * spacing
    result: list[DesignPath] = []
    while scan_y <= maximum_y + 1e-9:
        intersections: list[float] = []
        for start, end in pairwise(rotated):
            if math.isclose(start.y, end.y):
                continue
            low, high = sorted((start.y, end.y))
            if low <= scan_y < high:
                ratio = (scan_y - start.y) / (end.y - start.y)
                intersections.append(start.x + ratio * (end.x - start.x))
        intersections.sort()
        for index in range(0, len(intersections) - 1, 2):
            start = unrotate(Point(x=intersections[index], y=scan_y))
            end = unrotate(Point(x=intersections[index + 1], y=scan_y))
            converted = _polyline_path(f"{path.path_id}-{prefix}-{len(result) + 1}", [start, end])
            if converted is not None:
                result.append(converted)
        scan_y += spacing
    return result


def _color(value: str | None) -> str:
    if not value or value in {"none", "currentColor"}:
        return "#171717"
    if re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        return value.lower()
    if re.fullmatch(r"#[0-9a-fA-F]{3}", value):
        return "#" + "".join(character * 2 for character in value[1:].lower())
    match = re.fullmatch(r"rgb\(\s*(\d+)\D+(\d+)\D+(\d+)\s*\)", value)
    if match:
        return "#" + "".join(f"{min(255, int(item)):02x}" for item in match.groups())
    return "#171717"


def import_svg(
    content: bytes,
    recipe: ProjectRecipe,
    *,
    source_sha256: str | None = None,
    checkpoint: Callable[[str, int, int], None] | None = None,
) -> DesignDocument:
    if len(content) > MAX_SVG_BYTES:
        raise ValueError("SVG exceeds the 25 MiB limit")
    lowered = content[:8192].lower()
    if b"<!doctype" in lowered or b"<!entity" in lowered:
        raise ValueError("SVG DTD and entity declarations are not supported")
    try:
        root = ET.fromstring(content)
    except ET.ParseError as error:
        raise ValueError(f"invalid SVG XML: {error}") from error
    if _local_name(root.tag) != "svg":
        raise ValueError("source asset root is not <svg>")
    elements = list(root.iter())
    if len(elements) > MAX_SVG_NODES:
        raise ValueError(f"SVG exceeds the {MAX_SVG_NODES} node limit")

    diagnostics: list[DesignDiagnostic] = []
    diagnostic_keys: set[tuple[str, str | None]] = set()

    def warn(code: str, message: str, element: ET.Element) -> None:
        element_id = element.attrib.get("id")
        key = (code, element_id)
        if key not in diagnostic_keys:
            diagnostics.append(DesignDiagnostic(code=code, message=message, element_id=element_id))
            diagnostic_keys.add(key)

    view_box_values = [float(value) for value in re.findall(NUMBER, root.get("viewBox", ""))]
    if len(view_box_values) == 4:
        min_x, min_y, view_width, view_height = view_box_values
    else:
        width_units = _number(root.get("width"), 300)
        height_units = _number(root.get("height"), 150)
        min_x, min_y, view_width, view_height = 0.0, 0.0, width_units, height_units
    if view_width <= 0 or view_height <= 0:
        raise ValueError("SVG viewBox must have positive dimensions")
    width_mm = _length_mm(root.get("width"), default=view_width * 25.4 / 96)
    height_mm = _length_mm(root.get("height"), default=view_height * 25.4 / 96)
    scale = (
        min(
            (recipe.page.width_mm - 2 * recipe.page.margin_mm) / width_mm,
            (recipe.page.height_mm - 2 * recipe.page.margin_mm) / height_mm,
        )
        if recipe.svg_import.fit_to_page
        else 1.0
    )
    output_width = width_mm * scale
    output_height = height_mm * scale
    left = (recipe.page.width_mm - output_width) / 2
    bottom = (recipe.page.height_mm - output_height) / 2
    sx = output_width / view_width
    sy = output_height / view_height
    root_matrix: Matrix = (
        sx,
        0,
        0,
        -sy,
        left - min_x * sx,
        bottom + output_height + min_y * sy,
    )

    id_map = {element.attrib["id"]: element for element in elements if "id" in element.attrib}
    layers: dict[str, _LayerBuilder] = {}
    layer_order: list[str] = []
    emitted_ids: set[str] = set()
    element_counter = 0

    def builder(name: str) -> _LayerBuilder:
        key = _slug(name)
        if key not in layers:
            unique_key = key
            suffix = 2
            while unique_key in layers:
                unique_key = f"{key}-{suffix}"
                suffix += 1
            layers[unique_key] = _LayerBuilder(name=name, role=unique_key)
            layer_order.append(unique_key)
            return layers[unique_key]
        return layers[key]

    def visit(
        element: ET.Element,
        parent_matrix: Matrix,
        inherited_style: dict[str, str],
        layer: _LayerBuilder,
        *,
        use_stack: tuple[str, ...] = (),
        depth: int = 0,
    ) -> None:
        nonlocal element_counter
        element_counter += 1
        if checkpoint is not None:
            checkpoint("parse-svg", element_counter, len(elements))
        tag = _local_name(element.tag)
        if tag in UNSUPPORTED_TAGS:
            warn(UNSUPPORTED_TAGS[tag], f"SVG <{tag}> is not imported.", element)
            return
        if tag in {"defs", "symbol", "clipPath"} and not use_stack:
            if tag == "clipPath":
                warn(
                    "unsupported-clip-path",
                    "SVG clipPath is currently approximated by page clipping.",
                    element,
                )
            return
        style = _style(element, inherited_style)
        if style.get("display") == "none" or style.get("visibility") == "hidden":
            return
        local = _transform_matrix(element.get("transform"))
        combined = _multiply(parent_matrix, local)
        current_layer = layer
        if tag == "g" and depth == 1:
            current_layer = builder(_layer_name(element))
        if tag == "use":
            href = element.get("href") or element.get("{http://www.w3.org/1999/xlink}href")
            if not href or not href.startswith("#"):
                warn(
                    "external-resource-removed",
                    "Only local fragment <use> references are supported.",
                    element,
                )
                return
            reference_id = href[1:]
            if reference_id in use_stack:
                warn("cyclic-use", "Cyclic SVG <use> reference was skipped.", element)
                return
            referenced = id_map.get(reference_id)
            if referenced is None:
                warn(
                    "missing-use-target",
                    f"SVG <use> target #{reference_id} was not found.",
                    element,
                )
                return
            translation = (1, 0, 0, 1, _number(element.get("x")), _number(element.get("y")))
            visit(
                referenced,
                _multiply(combined, translation),
                style,
                current_layer,
                use_stack=(*use_stack, reference_id),
                depth=depth + 1,
            )
            return
        if tag in DRAWABLE_TAGS:
            element_id = element.attrib.get("id") or f"{tag}-{element_counter}"
            raw_paths = _shape_paths(element, _slug(element_id), style)
            fill = style.get("fill", "black")
            stroke = style.get("stroke", "none")
            for raw_path in raw_paths:
                transformed = _transform_path(raw_path, _multiply(root_matrix, combined))
                candidates: list[DesignPath] = []
                if stroke != "none":
                    if recipe.svg_import.stroke_mode == "centerline":
                        candidates.append(transformed)
                    else:
                        width = max(0.1, _number(style.get("stroke-width"), 1.0) * (sx + sy) / 2)
                        offsets = (
                            (-width / 2, width / 2)
                            if recipe.svg_import.stroke_mode == "outline"
                            else (-width, 0.0, width)
                        )
                        candidates.extend(
                            _offset_paths(
                                transformed,
                                offsets,
                                recipe.svg_import.stroke_mode,
                            )
                        )
                if fill != "none":
                    if recipe.svg_import.fill_mode == "outline":
                        candidates.append(transformed)
                    elif (
                        recipe.svg_import.fill_mode in {"hatch", "crosshatch"}
                        and transformed.closed
                    ):
                        candidates.extend(
                            _hatch_paths(
                                transformed,
                                spacing=recipe.svg_import.hatch_spacing_mm,
                                angle_degrees=recipe.svg_import.hatch_angle_degrees,
                                prefix="hatch",
                            )
                        )
                        if recipe.svg_import.fill_mode == "crosshatch":
                            candidates.extend(
                                _hatch_paths(
                                    transformed,
                                    spacing=recipe.svg_import.hatch_spacing_mm,
                                    angle_degrees=recipe.svg_import.hatch_angle_degrees + 90,
                                    prefix="crosshatch",
                                )
                            )
                    elif recipe.svg_import.fill_mode in {"hatch", "crosshatch"}:
                        warn(
                            "open-fill-ignored",
                            "A fill on an open path could not be hatched.",
                            element,
                        )
                dash_value = style.get("stroke-dasharray")
                if stroke != "none" and dash_value and dash_value != "none":
                    dash_values = [
                        _number(value) * (sx + sy) / 2 for value in re.findall(NUMBER, dash_value)
                    ]
                    candidates = [
                        dashed
                        for candidate in candidates
                        for dashed in _dash_paths(candidate, dash_values)
                    ]
                for candidate in candidates:
                    digest = canonical_sha256(candidate.model_dump(mode="json"))
                    if digest in emitted_ids:
                        continue
                    emitted_ids.add(digest)
                    assert current_layer.paths is not None
                    current_layer.paths.append(candidate)
                current_layer.preview_color = _color(stroke if stroke != "none" else fill)
        elif tag not in {"svg", "g", "defs", "symbol", "title", "desc", "metadata"}:
            warn("unsupported-element", f"SVG <{tag}> is not supported.", element)
        for child in element:
            visit(child, combined, style, current_layer, use_stack=use_stack, depth=depth + 1)

    default_layer = builder("SVG")
    visit(
        root,
        IDENTITY,
        {"fill": "black", "stroke": "none", "visibility": "visible"},
        default_layer,
    )
    design_layers = [
        DesignLayer(
            layer_id=f"layer-{key}",
            name=layers[key].name,
            semantic_role=layers[key].role,
            preview_color=layers[key].preview_color,
            paths=layers[key].paths or [],
            metadata={"source": "svg"},
        )
        for key in layer_order
        if layers[key].paths
    ]
    if not design_layers:
        raise ValueError("SVG import produced no plottable geometry")
    source_digest = source_sha256 or hashlib.sha256(content).hexdigest()
    document = DesignDocument(
        document_id=f"{recipe.project_id}-svg-design",
        page=recipe.page,
        layers=design_layers,
        metadata=DesignMetadata(
            generator_id=SVG_IMPORTER_ID,
            generator_version=SVG_IMPORTER_VERSION,
            seed="",
            quality=recipe.mode.quality,
            source_asset_sha256=source_digest,
            diagnostics=diagnostics,
        ),
    )
    digest = canonical_sha256(document)
    if checkpoint is not None:
        checkpoint("complete", len(elements), len(elements))
    return document.model_copy(
        update={"metadata": document.metadata.model_copy(update={"normalized_sha256": digest})}
    )
