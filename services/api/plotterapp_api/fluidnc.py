from __future__ import annotations

import asyncio
import json
import math
import os
import re
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Sequence
from pathlib import Path
from typing import Literal, Protocol

from plotter_core.gcode.parser import reconstruct_toolpath
from plotter_core.models import GcodeProgram, MachineProfile, SkewCalibration, StrictModel
from pydantic import Field, field_validator, model_validator
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import WebSocketException

from plotterapp_api.fluidnc_tests import (
    FluidNCCommissioningTestId,
    FluidNCCommissioningTestRequest,
    build_commissioning_test_frames,
)

FLUIDNC_CONFIG_ENV = "PLOTTERAPP_FLUIDNC_CONFIG"
MAX_RESPONSE_BYTES = 64 * 1024
MAX_RESPONSE_LINES = 500
MAX_LINE_LENGTH = 500
MAX_PROGRAM_COMMANDS = 100_000

FluidNCAction = Literal[
    "identify",
    "status",
    "modal",
    "config",
    "limits",
    "hold",
    "alarm_reset",
    "home",
    "jog",
    "pen_test",
    "commissioning_test",
]


class FluidNCSettings(StrictModel):
    schema_version: Literal[1] = 1
    host: str = Field(default="fluidnc.local", min_length=1, max_length=253)
    port: int = Field(default=81, ge=1, le=65535)
    http_port: int = Field(default=80, ge=1, le=65535)
    tls: bool = False
    command_timeout_seconds: float = Field(default=15.0, ge=1.0, le=120.0)
    safe_z_min_mm: float = Field(default=-10.0, ge=-100.0, le=100.0)
    safe_z_max_mm: float = Field(default=0.0, ge=-100.0, le=100.0)
    pen_up_z_mm: float = Field(default=0.0, ge=-100.0, le=100.0)
    pen_down_z_mm: float = Field(default=-5.0, ge=-100.0, le=100.0)
    skew_calibration: SkewCalibration = Field(default_factory=SkewCalibration)

    @field_validator("host")
    @classmethod
    def validate_host(cls, value: str) -> str:
        host = value.strip().removeprefix("[").removesuffix("]")
        if not host or any(character.isspace() for character in host):
            raise ValueError("FluidNC host must not be blank or contain whitespace")
        if any(character in host for character in "/?#@") or "://" in host:
            raise ValueError("enter a hostname or IP address without a URL scheme or path")
        if not re.fullmatch(r"[A-Za-z0-9._:%-]+", host):
            raise ValueError("FluidNC host contains unsupported characters")
        return host

    @model_validator(mode="after")
    def validate_safe_z_range(self) -> FluidNCSettings:
        if self.safe_z_min_mm >= self.safe_z_max_mm:
            raise ValueError("safe Z minimum must be below the safe Z maximum")
        if not self.safe_z_min_mm <= self.pen_down_z_mm < self.pen_up_z_mm <= self.safe_z_max_mm:
            raise ValueError("pen up/down Z values must be within the configured safe Z range")
        return self

    @property
    def websocket_url(self) -> str:
        scheme = "wss" if self.tls else "ws"
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{scheme}://{host}:{self.port}/"

    @property
    def http_url(self) -> str:
        scheme = "https" if self.tls else "http"
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{scheme}://{host}:{self.http_port}"


class FluidNCActionRequest(StrictModel):
    action: FluidNCAction
    axis: Literal["X", "Y", "Z", "XY", "ALL"] | None = None
    distance_mm: float | None = None
    feed_mm_min: float | None = None
    pen_up_mm: float | None = None
    pen_down_mm: float | None = None
    test: FluidNCCommissioningTestRequest | None = None


class FluidNCActionResult(StrictModel):
    schema_version: Literal[1] = 1
    action: FluidNCAction
    success: bool
    command_summary: list[str]
    response_lines: list[str]
    controller_state: str | None = None
    test_id: FluidNCCommissioningTestId | None = None


class FluidNCProgramResult(StrictModel):
    """Result of delivering one already-validated program to the controller.

    ``success`` means every command was acknowledged by FluidNC.  It intentionally does
    not claim that the physical motion has finished: an accepted program can still be
    running, paused at an M0, or stopped later by the controller.
    """

    schema_version: Literal[1] = 1
    filename: str
    sha256: str
    success: bool
    command_count: int
    accepted_command_count: int
    response_lines: list[str]
    controller_state: str | None = None


class FluidNCStoredPass(StrictModel):
    pass_id: str
    name: str
    priority: int = Field(ge=1)
    filename: str
    sd_path: str
    sha256: str
    byte_count: int = Field(ge=1)


class FluidNCProjectRunResult(StrictModel):
    """Validated pass files stored on SD and the ordered combined job that was started."""

    schema_version: Literal[1] = 1
    project_id: str
    sd_folder: str
    passes: list[FluidNCStoredPass]
    run_path: str
    success: bool
    response_lines: list[str]
    controller_state: str | None = None


class AxisCalibrationRequest(StrictModel):
    current_steps_per_mm: float = Field(gt=0, le=100_000)
    commanded_distance_mm: float = Field(gt=0, le=1_000)
    measured_distance_mm: float = Field(gt=0, le=1_000)


class AxisCalibrationResult(StrictModel):
    schema_version: Literal[1] = 1
    corrected_steps_per_mm: float
    distance_error_percent: float


class SkewCalibrationRequest(StrictModel):
    square_width_mm: float = Field(gt=0, le=1_000)
    square_height_mm: float = Field(gt=0, le=1_000)
    rising_diagonal_mm: float = Field(gt=0, le=2_000)
    falling_diagonal_mm: float = Field(gt=0, le=2_000)


class FluidNCGatewayProtocol(Protocol):
    def settings(self) -> FluidNCSettings: ...

    def save_settings(self, settings: FluidNCSettings) -> FluidNCSettings: ...

    async def execute(self, request: FluidNCActionRequest) -> FluidNCActionResult: ...

    async def stream_program(
        self,
        program: GcodeProgram,
        *,
        profile: MachineProfile | None = None,
        start_line: int = 1,
    ) -> FluidNCProgramResult: ...

    async def store_and_run_project(
        self,
        project_id: str,
        project_name: str,
        pass_programs: Sequence[tuple[str, str, GcodeProgram]],
        combined_program: GcodeProgram,
    ) -> FluidNCProjectRunResult: ...


def default_fluidnc_config_path() -> Path:
    configured = os.environ.get(FLUIDNC_CONFIG_ENV)
    if configured:
        return Path(configured).resolve()
    projects_root = os.environ.get("PLOTTERAPP_PROJECTS_ROOT")
    if projects_root:
        return Path(projects_root).resolve().parent / "fluidnc.json"
    return (Path.cwd() / ".plotterapp-data" / "fluidnc.json").resolve()


def calculate_axis_calibration(request: AxisCalibrationRequest) -> AxisCalibrationResult:
    corrected = (
        request.current_steps_per_mm * request.commanded_distance_mm / request.measured_distance_mm
    )
    error_percent = (
        (request.measured_distance_mm - request.commanded_distance_mm)
        / request.commanded_distance_mm
        * 100.0
    )
    if not math.isfinite(corrected) or not math.isfinite(error_percent):
        raise ValueError("axis calibration inputs produced a non-finite result")
    return AxisCalibrationResult(
        corrected_steps_per_mm=round(corrected, 6),
        distance_error_percent=round(error_percent, 4),
    )


def calculate_skew_calibration(request: SkewCalibrationRequest) -> SkewCalibration:
    """Calculate the angle between the physical X/Y axes from both rectangle diagonals."""

    cosine = (
        request.rising_diagonal_mm**2 - request.falling_diagonal_mm**2
    ) / (4 * request.square_width_mm * request.square_height_mm)
    if not math.isfinite(cosine) or not -1 < cosine < 1:
        raise ValueError("diagonal measurements cannot describe a valid calibration rectangle")
    angle = math.degrees(math.acos(cosine))
    if not 80 <= angle <= 100:
        raise ValueError("measured skew exceeds the supported safe range of 80° through 100°")
    return SkewCalibration(
        enabled=True,
        square_width_mm=request.square_width_mm,
        square_height_mm=request.square_height_mm,
        rising_diagonal_mm=request.rising_diagonal_mm,
        falling_diagonal_mm=request.falling_diagonal_mm,
        axis_angle_degrees=round(angle, 6),
    )


def build_action_frames(request: FluidNCActionRequest) -> tuple[list[str], list[str]]:
    if request.action == "identify":
        return ["$I\n"], ["$I"]
    if request.action == "status":
        return ["?"], ["?"]
    if request.action == "modal":
        return ["$G\n"], ["$G"]
    if request.action == "config":
        return ["$CD\n"], ["$CD"]
    if request.action == "limits":
        return ["$Limits\n"], ["$Limits", "! (exit limit mode)"]
    if request.action == "hold":
        return ["!"], ["! (feed hold)"]
    if request.action == "alarm_reset":
        return ["$X\n"], ["$X (clear alarm / unlock)"]
    if request.action == "home":
        home_axis = request.axis or "ALL"
        command = "$H" if home_axis == "ALL" else f"$H={home_axis}"
        return [f"{command}\n"], [command]
    if request.action == "jog":
        jog_axis = request.axis
        if jog_axis not in {"X", "Y", "Z"}:
            raise ValueError("jog requires axis X, Y, or Z")
        distance = request.distance_mm
        feed = request.feed_mm_min
        if distance is None or not math.isfinite(distance) or distance == 0:
            raise ValueError("jog distance must be a finite non-zero value")
        if feed is None or not math.isfinite(feed) or feed <= 0:
            raise ValueError("jog feed must be a finite positive value")
        command = f"$J=G91 G21 F{_number(feed)} {jog_axis}{_number(distance)}"
        return [f"{command}\n"], [command]
    if request.action == "pen_test":
        up = request.pen_up_mm
        down = request.pen_down_mm
        feed = request.feed_mm_min
        if up is None or down is None or not all(math.isfinite(value) for value in (up, down)):
            raise ValueError("pen test requires finite up and down Z values")
        if not (-20 <= up <= 20 and -20 <= down <= 20):
            raise ValueError("pen test Z values are limited to -20 through 20 mm")
        if up == down:
            raise ValueError("pen up and down Z values must differ")
        if feed is None or not math.isfinite(feed) or not 1 <= feed <= 1_500:
            raise ValueError("pen test feed must be between 1 and 1500 mm/min")
        commands = [
            "G21",
            "G90",
            f"G1 Z{_number(up)} F{_number(feed)}",
            f"G1 Z{_number(down)} F{_number(feed)}",
            f"G1 Z{_number(up)} F{_number(feed)}",
        ]
        return [f"{command}\n" for command in commands], commands
    if request.action == "commissioning_test":
        if request.test is None:
            raise ValueError("commissioning_test requires a named test definition")
        return build_commissioning_test_frames(request.test)
    raise ValueError(f"unsupported FluidNC action: {request.action}")


def _number(value: float) -> str:
    return f"{value:.3f}".rstrip("0").rstrip(".")


def _parse_controller_state(lines: Sequence[str]) -> str | None:
    for line in reversed(lines):
        match = re.search(r"<([^|>]+)(?:\||>)", line)
        if match:
            return match.group(1)
    return None


def _normalize_message(message: str | bytes) -> list[str]:
    text = message.decode("utf-8", errors="replace") if isinstance(message, bytes) else message
    return [line.strip()[:MAX_LINE_LENGTH] for line in text.splitlines() if line.strip()]


def _program_frames(text: str) -> list[str]:
    """Convert a validated export to executable controller frames.

    Semicolon comments and blank lines carry no controller state, so omitting them makes
    the acknowledgement count correspond to commands actually delivered.  All other
    lines are retained verbatim (apart from their line ending), including M0 messages.
    """
    return [
        f"{line}\n"
        for raw_line in text.splitlines()
        if (line := raw_line.strip()) and not line.startswith(";")
    ]


def _sd_project_folder(project_id: str, project_name: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "-", project_name.lower()).strip("-") or "project"
    identifier = re.sub(r"[^a-zA-Z0-9_-]+", "-", project_id).strip("-")
    return f"/plotbox/{name[:40]}-{identifier[:12]}"


def _format_gcode_number(value: float, decimals: int = 3) -> str:
    if decimals == 0:
        return f"{value:.0f}"
    rendered = f"{value:.{decimals}f}".rstrip("0").rstrip(".")
    return "0" if rendered in {"", "-0"} else rendered


def _resume_program_frames(
    program: GcodeProgram,
    profile: MachineProfile,
    start_line: int,
) -> list[str]:
    """Build a pen-safe restart while retaining the validated source program."""
    source_lines = program.text.splitlines()
    if start_line < 1 or start_line > len(source_lines):
        raise ValueError(
            f"start line must be between 1 and {len(source_lines)} for {program.filename}"
        )
    if start_line == 1:
        return _program_frames(program.text)

    prior = [item for item in program.parsed_instructions if item.line_number < start_line]
    remaining = [item for item in program.parsed_instructions if item.line_number >= start_line]
    state = reconstruct_toolpath(prior, profile)
    actuator = profile.pen_actuator
    precision = profile.precision_decimals
    preamble = [
        "G21\n",
        "G90\n",
        "G17\n",
        "G94\n",
        (
            f"G1 Z{_format_gcode_number(actuator.up_mm, precision)} "
            f"F{_format_gcode_number(actuator.lift_feed_mm_min, 0)}\n"
        ),
    ]
    if actuator.dwell_after_up_ms:
        preamble.append(
            f"G4 P{_format_gcode_number(actuator.dwell_after_up_ms / 1000, 3)}\n"
        )
    preamble.append(
        f"G0 X{_format_gcode_number(state.final_position.x, precision)} "
        f"Y{_format_gcode_number(state.final_position.y, precision)} "
        f"F{_format_gcode_number(profile.motion.travel_feed_mm_min, 0)}\n"
    )

    first = remaining[0] if remaining else None
    first_explicitly_lifts = bool(
        first
        and first.command in {"G0", "G1"}
        and first.parameters.get("Z", actuator.up_mm - 1) >= actuator.up_mm - 1e-9
    )
    if state.final_z_mm < actuator.up_mm - 1e-9 and not first_explicitly_lifts:
        preamble.append(
            f"G1 Z{_format_gcode_number(state.final_z_mm, precision)} "
            f"F{_format_gcode_number(actuator.lower_feed_mm_min, 0)}\n"
        )
        if actuator.dwell_after_down_ms:
            preamble.append(
                f"G4 P{_format_gcode_number(actuator.dwell_after_down_ms / 1000, 3)}\n"
            )

    return [*preamble, *_program_frames("\n".join(source_lines[start_line - 1 :]))]


class FluidNCGateway:
    def __init__(self, config_path: Path | None = None) -> None:
        self.config_path = (config_path or default_fluidnc_config_path()).resolve()

    def settings(self) -> FluidNCSettings:
        if not self.config_path.exists():
            return FluidNCSettings()
        return FluidNCSettings.model_validate_json(self.config_path.read_text(encoding="utf-8"))

    def save_settings(self, settings: FluidNCSettings) -> FluidNCSettings:
        self.config_path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(settings.model_dump(mode="json"), indent=2, sort_keys=True) + "\n"
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.config_path.name}.", suffix=".tmp", dir=self.config_path.parent
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.config_path)
        finally:
            temporary_path.unlink(missing_ok=True)
        return settings

    async def execute(self, request: FluidNCActionRequest) -> FluidNCActionResult:
        frames, summaries = build_action_frames(request)
        settings = self.settings()
        try:
            if request.action == "limits":
                lines = await self._limit_check(settings)
            else:
                lines = await self._exchange(
                    settings,
                    frames,
                    realtime=request.action in {"status", "hold"},
                )
        except (OSError, TimeoutError, WebSocketException) as error:
            raise ConnectionError(f"FluidNC WebSocket request failed: {error}") from error
        errors = [
            line
            for line in lines
            if line.lower().startswith("error") or line.upper().startswith("ALARM")
        ]
        return FluidNCActionResult(
            action=request.action,
            success=not errors,
            command_summary=summaries,
            response_lines=lines,
            controller_state=_parse_controller_state(lines),
            test_id=request.test.test_id if request.test is not None else None,
        )

    async def stream_program(
        self,
        program: GcodeProgram,
        *,
        profile: MachineProfile | None = None,
        start_line: int = 1,
    ) -> FluidNCProgramResult:
        """Deliver a generated program one acknowledged line at a time.

        This gateway deliberately accepts a ``GcodeProgram`` rather than raw text.  The
        API creates that object only through the exporter, after its independent round-trip
        validator passes.  Keeping the raw G-code boundary out of the request prevents the
        editor send endpoint from becoming an arbitrary command console.
        """
        if not program.validation.valid:
            raise ValueError("refusing to stream a G-code program that failed validation")
        if start_line == 1:
            frames = _program_frames(program.text)
        else:
            if profile is None:
                raise ValueError("a machine profile is required when resuming from a G-code line")
            frames = _resume_program_frames(program, profile, start_line)
        if not frames:
            raise ValueError("refusing to stream an empty G-code program")
        if len(frames) > MAX_PROGRAM_COMMANDS:
            raise ValueError(
                f"refusing to stream more than {MAX_PROGRAM_COMMANDS} G-code commands"
            )

        settings = self.settings()
        lines: list[str] = []
        accepted = 0
        try:
            async with connect(
                settings.websocket_url,
                open_timeout=settings.command_timeout_seconds,
                close_timeout=2,
                ping_interval=20,
                ping_timeout=10,
                max_size=MAX_RESPONSE_BYTES,
                max_queue=16,
                compression=None,
                proxy=None,
            ) as connection:
                # Never append a job to a controller that has not positively reported Idle.
                await connection.send("?")
                status_lines = await self._receive_response(
                    connection,
                    settings.command_timeout_seconds,
                    allow_empty=False,
                )
                lines.extend(status_lines[-MAX_RESPONSE_LINES:])
                controller_state = _parse_controller_state(status_lines)
                if controller_state != "Idle":
                    raise ValueError(
                        "controller must report Idle before sending a project program "
                        f"(reported {controller_state or 'no machine state'})"
                    )

                for frame in frames:
                    await connection.send(frame)
                    response = await self._receive_response(
                        connection,
                        settings.command_timeout_seconds,
                        allow_empty=False,
                    )
                    lines.extend(response)
                    lines = lines[-MAX_RESPONSE_LINES:]
                    if any(
                        line.lower().startswith("error") or line.upper().startswith("ALARM")
                        for line in response
                    ):
                        await connection.send("!")
                        lines.extend(
                            await self._receive_response(connection, 1.0, allow_empty=True)
                        )
                        return FluidNCProgramResult(
                            filename=program.filename,
                            sha256=program.sha256,
                            success=False,
                            command_count=len(frames),
                            accepted_command_count=accepted,
                            response_lines=lines[-MAX_RESPONSE_LINES:],
                            controller_state=_parse_controller_state(lines),
                        )
                    accepted += 1
        except (OSError, TimeoutError, WebSocketException) as error:
            raise ConnectionError(f"FluidNC G-code stream failed: {error}") from error

        return FluidNCProgramResult(
            filename=program.filename,
            sha256=program.sha256,
            success=True,
            command_count=len(frames),
            accepted_command_count=accepted,
            response_lines=lines[-MAX_RESPONSE_LINES:],
            controller_state=_parse_controller_state(lines),
        )

    async def store_and_run_project(
        self,
        project_id: str,
        project_name: str,
        pass_programs: Sequence[tuple[str, str, GcodeProgram]],
        combined_program: GcodeProgram,
    ) -> FluidNCProjectRunResult:
        """Store validated pass files on FluidNC SD, then run their ordered combined job."""
        if not pass_programs:
            raise ValueError("refusing to store a project with no enabled pen passes")
        programs = [program for _, _, program in pass_programs]
        if any(not program.validation.valid for program in [*programs, combined_program]):
            raise ValueError("refusing to upload a G-code program that failed validation")

        settings = self.settings()
        folder = _sd_project_folder(project_id, project_name)
        await self._webdav_mkdir(settings, "/plotbox")
        await self._webdav_mkdir(settings, folder)

        stored: list[FluidNCStoredPass] = []
        for priority, (pass_id, name, program) in enumerate(pass_programs, start=1):
            path = f"{folder}/{program.filename}"
            await self._webdav_put(settings, path, program.text.encode("utf-8"))
            stored.append(
                FluidNCStoredPass(
                    pass_id=pass_id,
                    name=name,
                    priority=priority,
                    filename=program.filename,
                    sd_path=path,
                    sha256=program.sha256,
                    byte_count=len(program.text.encode("utf-8")),
                )
            )

        run_path = f"{folder}/run-all.nc"
        await self._webdav_put(settings, run_path, combined_program.text.encode("utf-8"))
        try:
            lines = await self._start_sd_program(settings, run_path)
        except (OSError, TimeoutError, WebSocketException) as error:
            raise ConnectionError(f"FluidNC SD run failed: {error}") from error
        errors = [
            line
            for line in lines
            if line.lower().startswith("error") or line.upper().startswith("ALARM")
        ]
        return FluidNCProjectRunResult(
            project_id=project_id,
            sd_folder=folder,
            passes=stored,
            run_path=run_path,
            success=not errors,
            response_lines=lines[-MAX_RESPONSE_LINES:],
            controller_state=_parse_controller_state(lines),
        )

    async def _webdav_mkdir(self, settings: FluidNCSettings, sd_path: str) -> None:
        await asyncio.to_thread(
            self._webdav_request, settings, "MKCOL", sd_path, None, {200, 201, 204, 405}
        )

    async def _webdav_put(
        self, settings: FluidNCSettings, sd_path: str, content: bytes
    ) -> None:
        await asyncio.to_thread(
            self._webdav_request,
            settings,
            "PUT",
            sd_path,
            content,
            {200, 201, 204},
        )

    def _webdav_request(
        self,
        settings: FluidNCSettings,
        method: str,
        sd_path: str,
        content: bytes | None,
        accepted_statuses: set[int],
    ) -> None:
        # FluidNC exposes the SD card as WebDAV under /sd.
        encoded_path = urllib.parse.quote(sd_path, safe="/")
        request = urllib.request.Request(
            f"{settings.http_url}/sd{encoded_path}",
            data=content,
            method=method,
            headers={"Content-Type": "application/octet-stream"},
        )
        try:
            with urllib.request.urlopen(
                request, timeout=settings.command_timeout_seconds
            ) as response:
                if response.status not in accepted_statuses:
                    raise ConnectionError(
                        f"FluidNC SD {method} returned HTTP {response.status} for {sd_path}"
                    )
        except urllib.error.HTTPError as error:
            if error.code not in accepted_statuses:
                raise ConnectionError(
                    f"FluidNC SD {method} returned HTTP {error.code} for {sd_path}"
                ) from error
        except (OSError, TimeoutError) as error:
            raise ConnectionError(f"FluidNC SD {method} failed for {sd_path}: {error}") from error

    async def _start_sd_program(
        self, settings: FluidNCSettings, sd_path: str
    ) -> list[str]:
        async with connect(
            settings.websocket_url,
            open_timeout=settings.command_timeout_seconds,
            close_timeout=2,
            ping_interval=20,
            ping_timeout=10,
            max_size=MAX_RESPONSE_BYTES,
            max_queue=16,
            compression=None,
            proxy=None,
        ) as connection:
            await connection.send("?")
            status = await self._receive_response(
                connection, settings.command_timeout_seconds, allow_empty=False
            )
            state = _parse_controller_state(status)
            if state != "Idle":
                raise ValueError(
                    "controller must report Idle before starting an SD project "
                    f"(reported {state or 'no machine state'})"
                )
            await connection.send(f"$SD/Run={sd_path}\n")
            response = await self._receive_response(
                connection, settings.command_timeout_seconds, allow_empty=False
            )
            return [*status, *response]

    async def _exchange(
        self,
        settings: FluidNCSettings,
        frames: Sequence[str],
        *,
        realtime: bool,
    ) -> list[str]:
        lines: list[str] = []
        async with connect(
            settings.websocket_url,
            open_timeout=settings.command_timeout_seconds,
            close_timeout=2,
            ping_interval=20,
            ping_timeout=10,
            max_size=MAX_RESPONSE_BYTES,
            max_queue=16,
            compression=None,
            proxy=None,
        ) as connection:
            for frame in frames:
                await connection.send(frame)
                response = await self._receive_response(
                    connection,
                    settings.command_timeout_seconds,
                    allow_empty=realtime,
                )
                lines.extend(response[: max(0, MAX_RESPONSE_LINES - len(lines))])
                if any(
                    line.lower().startswith("error") or line.upper().startswith("ALARM")
                    for line in response
                ):
                    await connection.send("!")
                    hold_response = await self._receive_response(
                        connection,
                        1.0,
                        allow_empty=True,
                    )
                    lines.extend(hold_response[: MAX_RESPONSE_LINES - len(lines)])
                    break
        return lines

    async def _limit_check(self, settings: FluidNCSettings) -> list[str]:
        lines: list[str] = []
        async with connect(
            settings.websocket_url,
            open_timeout=settings.command_timeout_seconds,
            close_timeout=2,
            ping_interval=20,
            ping_timeout=10,
            max_size=MAX_RESPONSE_BYTES,
            max_queue=16,
            compression=None,
            proxy=None,
        ) as connection:
            await connection.send("$Limits\n")
            try:
                limit_response = await self._receive_response(
                    connection,
                    min(settings.command_timeout_seconds, 3.0),
                    allow_empty=False,
                    stop_on_terminal=False,
                )
                lines.extend(limit_response[:MAX_RESPONSE_LINES])
            finally:
                await connection.send("!")
                hold_response = await self._receive_response(
                    connection,
                    1.0,
                    allow_empty=True,
                )
                lines.extend(hold_response[: MAX_RESPONSE_LINES - len(lines)])
        return lines

    async def _receive_response(
        self,
        connection: ClientConnection,
        timeout_seconds: float,
        *,
        allow_empty: bool,
        stop_on_terminal: bool = True,
    ) -> list[str]:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout_seconds
        lines: list[str] = []
        byte_count = 0
        while len(lines) < MAX_RESPONSE_LINES and byte_count < MAX_RESPONSE_BYTES:
            remaining = deadline - loop.time()
            if remaining <= 0:
                break
            quiet_timeout = min(remaining, 0.3 if lines or allow_empty else remaining)
            try:
                message = await asyncio.wait_for(connection.recv(), quiet_timeout)
            except TimeoutError:
                break
            normalized = _normalize_message(message)
            byte_count += sum(len(line.encode("utf-8")) for line in normalized)
            lines.extend(normalized[: MAX_RESPONSE_LINES - len(lines)])
            if stop_on_terminal and any(
                line == "ok"
                or line.lower().startswith("error")
                or line.upper().startswith("ALARM")
                or line.startswith("<")
                for line in normalized
            ):
                break
        if not lines and not allow_empty:
            raise TimeoutError("controller returned no response before the configured timeout")
        return lines
