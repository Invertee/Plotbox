from __future__ import annotations

import re
from itertools import pairwise

from plotter_core.models import (
    GcodeInstruction,
    MachineProfile,
    Point,
    ReconstructedSegment,
    ReconstructedToolpath,
)

_PAREN_COMMENT = re.compile(r"\([^)]*\)")
_WORD = re.compile(r"([A-Z])([+-]?(?:\d+(?:\.\d*)?|\.\d+))")


def parse_gcode(text: str) -> list[GcodeInstruction]:
    """Tokenize the supported G-code subset without relying on writer state."""
    instructions: list[GcodeInstruction] = []
    for line_number, raw_line in enumerate(text.splitlines(), start=1):
        without_semicolon = raw_line.split(";", maxsplit=1)[0]
        source = _PAREN_COMMENT.sub("", without_semicolon).strip().upper()
        if not source:
            continue
        words = _WORD.findall(source)
        if not words:
            raise ValueError(f"line {line_number}: no supported G-code words")
        command_index = next(
            (index for index, (letter, _) in enumerate(words) if letter in {"G", "M"}), None
        )
        if command_index is None:
            raise ValueError(f"line {line_number}: missing G or M command")
        command_letter, command_number = words[command_index]
        numeric_command = float(command_number)
        if not numeric_command.is_integer():
            raise ValueError(f"line {line_number}: fractional commands are unsupported")
        command = f"{command_letter}{int(numeric_command)}"
        parameters = {
            letter: float(value)
            for index, (letter, value) in enumerate(words)
            if index != command_index
        }
        instructions.append(
            GcodeInstruction(
                line_number=line_number,
                command=command,
                parameters=parameters,
                source=raw_line,
            )
        )
    return instructions


def reconstruct_toolpath(
    instructions: list[GcodeInstruction], profile: MachineProfile
) -> ReconstructedToolpath:
    """Independently apply modal XY/Z state and recover pen-up/down motion."""
    x = 0.0
    y = 0.0
    z = profile.pen_actuator.up_mm
    absolute = False
    units_mm = False
    segments: list[ReconstructedSegment] = []
    pause_count = 0

    for instruction in instructions:
        command = instruction.command
        if command == "G21":
            units_mm = True
            continue
        if command == "G20":
            units_mm = False
            continue
        if command == "G90":
            absolute = True
            continue
        if command == "G91":
            absolute = False
            continue
        if command == "M0":
            pause_count += 1
            continue
        if command not in {"G0", "G1"}:
            continue
        if not units_mm or not absolute:
            raise ValueError(
                f"line {instruction.line_number}: motion before G21 and G90 modal setup"
            )
        parameters = instruction.parameters
        next_x = parameters.get("X", x)
        next_y = parameters.get("Y", y)
        next_z = parameters.get("Z", z)
        if "X" in parameters or "Y" in parameters:
            segments.append(
                ReconstructedSegment(
                    start=Point(x=x, y=y),
                    end=Point(x=next_x, y=next_y),
                    pen_down=next_z < profile.pen_actuator.up_mm - 1e-9,
                )
            )
        x, y, z = next_x, next_y, next_z

    draw_paths: list[list[Point]] = []
    current: list[Point] = []
    for segment in segments:
        if segment.pen_down:
            if not current or current[-1] != segment.start:
                if len(current) >= 2:
                    draw_paths.append(current)
                current = [segment.start]
            current.append(segment.end)
        elif len(current) >= 2:
            draw_paths.append(current)
            current = []
    if len(current) >= 2:
        draw_paths.append(current)

    # Collapse any repeated adjacent points caused by explicitly emitted zero-length positioning.
    normalized: list[list[Point]] = []
    for path in draw_paths:
        clean = [path[0]]
        for first, second in pairwise(path):
            if first != second and clean[-1] != second:
                clean.append(second)
        if len(clean) >= 2:
            normalized.append(clean)
    return ReconstructedToolpath(
        segments=segments,
        draw_paths=normalized,
        final_position=Point(x=x, y=y),
        final_z_mm=z,
        pause_count=pause_count,
    )
