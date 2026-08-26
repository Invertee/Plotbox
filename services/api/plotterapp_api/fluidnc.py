from __future__ import annotations

import asyncio
import json
import math
import os
import re
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Literal, Protocol

from plotter_core.models import StrictModel
from pydantic import Field, field_validator
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

FluidNCAction = Literal[
    "identify",
    "status",
    "modal",
    "config",
    "limits",
    "hold",
    "home",
    "jog",
    "pen_test",
    "commissioning_test",
]


class FluidNCSettings(StrictModel):
    schema_version: Literal[1] = 1
    host: str = Field(default="fluidnc.local", min_length=1, max_length=253)
    port: int = Field(default=81, ge=1, le=65535)
    tls: bool = False
    command_timeout_seconds: float = Field(default=15.0, ge=1.0, le=120.0)

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

    @property
    def websocket_url(self) -> str:
        scheme = "wss" if self.tls else "ws"
        host = f"[{self.host}]" if ":" in self.host else self.host
        return f"{scheme}://{host}:{self.port}/"


class FluidNCActionRequest(StrictModel):
    action: FluidNCAction
    confirmed: bool = False
    axis: Literal["X", "Y", "Z", "ALL"] | None = None
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


class AxisCalibrationRequest(StrictModel):
    current_steps_per_mm: float = Field(gt=0, le=100_000)
    commanded_distance_mm: float = Field(gt=0, le=1_000)
    measured_distance_mm: float = Field(gt=0, le=1_000)


class AxisCalibrationResult(StrictModel):
    schema_version: Literal[1] = 1
    corrected_steps_per_mm: float
    distance_error_percent: float


class FluidNCGatewayProtocol(Protocol):
    def settings(self) -> FluidNCSettings: ...

    def save_settings(self, settings: FluidNCSettings) -> FluidNCSettings: ...

    async def execute(self, request: FluidNCActionRequest) -> FluidNCActionResult: ...


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
    if request.action == "home":
        _require_confirmation(request)
        home_axis = request.axis or "ALL"
        command = "$H" if home_axis == "ALL" else f"$H={home_axis}"
        return [f"{command}\n"], [command]
    if request.action == "jog":
        _require_confirmation(request)
        jog_axis = request.axis
        if jog_axis not in {"X", "Y", "Z"}:
            raise ValueError("jog requires axis X, Y, or Z")
        distance = request.distance_mm
        feed = request.feed_mm_min
        if distance is None or not math.isfinite(distance) or distance == 0:
            raise ValueError("jog distance must be a finite non-zero value")
        if abs(distance) > 25:
            raise ValueError("jog distance is limited to 25 mm per action")
        if feed is None or not math.isfinite(feed) or not 1 <= feed <= 3_000:
            raise ValueError("jog feed must be between 1 and 3000 mm/min")
        command = f"$J=G91 G21 F{_number(feed)} {jog_axis}{_number(distance)}"
        return [f"{command}\n"], [command]
    if request.action == "pen_test":
        _require_confirmation(request)
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
        _require_confirmation(request)
        if request.test is None:
            raise ValueError("commissioning_test requires a named test definition")
        return build_commissioning_test_frames(request.test)
    raise ValueError(f"unsupported FluidNC action: {request.action}")


def _require_confirmation(request: FluidNCActionRequest) -> None:
    if not request.confirmed:
        raise ValueError(f"{request.action} requires explicit motion confirmation")


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
