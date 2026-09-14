from __future__ import annotations

import asyncio
import math
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from plotter_core.gcode.parser import parse_gcode
from plotter_core.models import GcodeProgram, MachineProfile, SkewCalibration
from plotterapp_api.fluidnc import (
    AxisCalibrationRequest,
    FluidNCActionRequest,
    FluidNCActionResult,
    FluidNCGateway,
    FluidNCProgramResult,
    FluidNCProjectRunResult,
    FluidNCSettings,
    FluidNCStoredPass,
    SkewCalibrationRequest,
    build_action_frames,
    calculate_axis_calibration,
    calculate_skew_calibration,
)
from plotterapp_api.fluidnc_tests import MAX_TEST_COMMANDS, FluidNCCommissioningTestRequest
from plotterapp_api.main import create_app


class FakeWebSocketConnection:
    def __init__(self) -> None:
        self.messages = ["Pn:X"]
        self.sent: list[str] = []

    async def __aenter__(self) -> FakeWebSocketConnection:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def send(self, message: str) -> None:
        self.sent.append(message)
        if message == "!":
            self.messages.append("ok")

    async def recv(self) -> str:
        if self.messages:
            return self.messages.pop(0)
        await asyncio.sleep(10)
        return ""


class ErrorWebSocketConnection(FakeWebSocketConnection):
    def __init__(self) -> None:
        super().__init__()
        self.messages = ["error: rejected", "ok"]


class ProgramWebSocketConnection(FakeWebSocketConnection):
    def __init__(self, fail_after_commands: int | None = None) -> None:
        super().__init__()
        self.messages = []
        self.command_count = 0
        self.fail_after_commands = fail_after_commands

    async def send(self, message: str) -> None:
        self.sent.append(message)
        if message == "?":
            self.messages.append("<Idle|MPos:0.000,0.000,5.000>")
        elif message == "!":
            self.messages.append("<Hold|MPos:0.000,0.000,5.000>")
        else:
            self.command_count += 1
            if self.fail_after_commands == self.command_count:
                self.messages.append("error: rejected")
            else:
                self.messages.append("ok")


class FakeFluidNCGateway:
    def __init__(self) -> None:
        self.current = FluidNCSettings()
        self.requests: list[FluidNCActionRequest] = []
        self.programs: list[GcodeProgram] = []
        self.program_options: list[tuple[MachineProfile | None, int]] = []
        self.sd_projects: list[
            tuple[str, str, list[tuple[str, str, GcodeProgram]], GcodeProgram]
        ] = []

    def settings(self) -> FluidNCSettings:
        return self.current

    def save_settings(self, settings: FluidNCSettings) -> FluidNCSettings:
        self.current = settings
        return settings

    async def execute(self, request: FluidNCActionRequest) -> FluidNCActionResult:
        self.requests.append(request)
        return FluidNCActionResult(
            action=request.action,
            success=True,
            command_summary=[request.action],
            response_lines=["<Idle|MPos:0.000,0.000,0.000>", "ok"],
            controller_state="Idle",
        )

    async def stream_program(
        self,
        program: GcodeProgram,
        *,
        profile: MachineProfile | None = None,
        start_line: int = 1,
    ) -> FluidNCProgramResult:
        self.programs.append(program)
        self.program_options.append((profile, start_line))
        return FluidNCProgramResult(
            filename=program.filename,
            sha256=program.sha256,
            success=True,
            command_count=program.statistics.instruction_count,
            accepted_command_count=program.statistics.instruction_count,
            response_lines=["ok"],
            controller_state="Idle",
        )

    async def store_and_run_project(
        self,
        project_id: str,
        project_name: str,
        pass_programs: list[tuple[str, str, GcodeProgram]],
        combined_program: GcodeProgram,
    ) -> FluidNCProjectRunResult:
        self.sd_projects.append((project_id, project_name, pass_programs, combined_program))
        folder = f"/plotbox/{project_id}"
        return FluidNCProjectRunResult(
            project_id=project_id,
            sd_folder=folder,
            passes=[
                FluidNCStoredPass(
                    pass_id=pass_id,
                    name=name,
                    priority=priority,
                    filename=program.filename,
                    sd_path=f"{folder}/{program.filename}",
                    sha256=program.sha256,
                    byte_count=len(program.text.encode("utf-8")),
                )
                for priority, (pass_id, name, program) in enumerate(pass_programs, start=1)
            ],
            run_path=f"{folder}/run-all.nc",
            success=True,
            response_lines=["<Idle|MPos:0,0,0>", "ok"],
            controller_state="Idle",
        )


def _valid_program(text: str, sha256: str = "a" * 64) -> GcodeProgram:
    return GcodeProgram(
        filename="boundary.nc",
        text=text,
        parsed_instructions=parse_gcode(text),
        reconstructed_toolpath={
            "segments": [],
            "draw_paths": [],
            "final_position": {"x": 0, "y": 0},
            "final_z_mm": 5,
            "pause_count": 0,
        },
        validation={
            "valid": True,
            "tolerance_mm": 0.001,
            "max_xy_error_mm": 0,
            "issues": [],
        },
        statistics={
            "instruction_count": 4,
            "draw_segment_count": 0,
            "travel_segment_count": 1,
            "pause_count": 0,
            "byte_count": 0,
        },
        sha256=sha256,
    )


def test_fluidnc_settings_validate_and_persist(tmp_path: Path) -> None:
    path = tmp_path / "fluidnc.json"
    gateway = FluidNCGateway(path)
    assert gateway.settings().websocket_url == "ws://fluidnc.local:81/"

    saved = gateway.save_settings(
        FluidNCSettings(host="192.168.1.44", port=82, tls=True, command_timeout_seconds=20)
    )
    assert saved.websocket_url == "wss://192.168.1.44:82/"
    assert FluidNCGateway(path).settings() == saved

    with pytest.raises(ValueError, match="without a URL scheme"):
        FluidNCSettings(host="ws://fluidnc.local")
    with pytest.raises(ValueError, match="without a URL scheme"):
        FluidNCSettings(host="user@fluidnc.local")


def test_fluidnc_action_builder_uses_controller_configured_jog_values() -> None:
    frames, summaries = build_action_frames(
        FluidNCActionRequest(
            action="jog",
            axis="Y",
            distance_mm=-260,
            feed_mm_min=12_000,
        )
    )
    assert frames == ["$J=G91 G21 F12000 Y-260\n"]
    assert summaries == ["$J=G91 G21 F12000 Y-260"]

    frames, summaries = build_action_frames(FluidNCActionRequest(action="alarm_reset"))
    assert frames == ["$X\n"]
    assert summaries == ["$X (clear alarm / unlock)"]

    frames, summaries = build_action_frames(FluidNCActionRequest(action="home", axis="XY"))
    assert frames == ["$H=XY\n"]
    assert summaries == ["$H=XY"]

    frames, _ = build_action_frames(
        FluidNCActionRequest(
            action="pen_test",
            pen_up_mm=5,
            pen_down_mm=0,
            feed_mm_min=400,
        )
    )
    assert frames[-3:] == ["G1 Z5 F400\n", "G1 Z0 F400\n", "G1 Z5 F400\n"]


@pytest.mark.parametrize(
    "test_id",
    [
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
    ],
)
def test_every_commissioning_pattern_is_bounded_and_finishes_pen_up(test_id: str) -> None:
    test = FluidNCCommissioningTestRequest(test_id=test_id)
    frames, summary = build_action_frames(
        FluidNCActionRequest(action="commissioning_test", test=test)
    )
    commands = [frame.rstrip("\n") for frame in frames]

    assert commands[:5] == ["G21", "G90", "G17", "G94", "G1 Z5 F600"]
    assert commands[-1] == "G1 Z5 F600"
    assert len(commands) <= MAX_TEST_COMMANDS
    assert summary == [test_id, f"{len(commands)} commands"]
    assert {command.split(" ", 1)[0] for command in commands} <= {
        "G0",
        "G1",
        "G2",
        "G3",
        "G4",
        "G17",
        "G21",
        "G90",
        "G94",
    }
    coordinates = [
        (match.group(1), float(match.group(2)))
        for command in commands
        for match in re.finditer(r"([XY])(-?\d+(?:\.\d+)?)", command)
    ]
    x_values = [value for axis, value in coordinates if axis == "X"]
    y_values = [value for axis, value in coordinates if axis == "Y"]
    assert all(test.origin_x_mm <= value <= test.origin_x_mm + test.width_mm for value in x_values)
    assert all(test.origin_y_mm <= value <= test.origin_y_mm + test.height_mm for value in y_values)
    if test_id == "circle_arc":
        assert any(command.startswith("G2 ") for command in commands)
        assert any(command.startswith("G3 ") for command in commands)
    if test_id == "lift_delay":
        assert any(command.startswith("G4 ") for command in commands)
        assert "G4 P0.1" in commands


def test_commissioning_pattern_validates_area_and_z_values() -> None:
    with pytest.raises(ValueError, match="positive X commissioning bound"):
        FluidNCCommissioningTestRequest(
            test_id="scale_grid",
            origin_x_mm=450,
            width_mm=100,
        )

    with pytest.raises(ValueError, match="pen-up Z"):
        FluidNCCommissioningTestRequest(test_id="scale_grid", z_up_mm=0, z_down_mm=0)

    with pytest.raises(ValueError, match="below pen-up Z"):
        FluidNCCommissioningTestRequest(
            test_id="z_depth_ladder",
            depth_start_mm=6,
            z_up_mm=5,
        )


def test_axis_calibration_formula() -> None:
    result = calculate_axis_calibration(
        AxisCalibrationRequest(
            current_steps_per_mm=80,
            commanded_distance_mm=100,
            measured_distance_mm=98,
        )
    )
    assert result.corrected_steps_per_mm == pytest.approx(81.632653)
    assert result.distance_error_percent == -2


def test_skew_calibration_formula_uses_both_rectangle_diagonals() -> None:
    angle = math.radians(89)
    rising = math.sqrt(20_000 + 20_000 * math.cos(angle))
    falling = math.sqrt(20_000 - 20_000 * math.cos(angle))

    result = calculate_skew_calibration(
        SkewCalibrationRequest(
            square_width_mm=100,
            square_height_mm=100,
            rising_diagonal_mm=rising,
            falling_diagonal_mm=falling,
        )
    )

    assert result.enabled is True
    assert result.axis_angle_degrees == pytest.approx(89)


def test_limit_check_always_sends_exit_realtime_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = FakeWebSocketConnection()
    monkeypatch.setattr("plotterapp_api.fluidnc.connect", lambda *_args, **_kwargs: connection)
    gateway = FluidNCGateway(tmp_path / "fluidnc.json")

    result = asyncio.run(gateway.execute(FluidNCActionRequest(action="limits")))

    assert result.success is True
    assert result.response_lines == ["Pn:X", "ok"]
    assert connection.sent == ["$Limits\n", "!"]


def test_controller_error_aborts_a_commissioning_sequence_with_feed_hold(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = ErrorWebSocketConnection()
    monkeypatch.setattr("plotterapp_api.fluidnc.connect", lambda *_args, **_kwargs: connection)
    gateway = FluidNCGateway(tmp_path / "fluidnc.json")
    test = FluidNCCommissioningTestRequest(test_id="scale_grid")

    result = asyncio.run(
        gateway.execute(FluidNCActionRequest(action="commissioning_test", test=test))
    )

    assert result.success is False
    assert connection.sent == ["G21\n", "!"]


def test_streamed_program_requires_idle_and_acknowledges_each_executable_command(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = ProgramWebSocketConnection()
    monkeypatch.setattr("plotterapp_api.fluidnc.connect", lambda *_args, **_kwargs: connection)
    gateway = FluidNCGateway(tmp_path / "fluidnc.json")
    program = _valid_program("; an export comment\nG21\nG90\nG0 X1 Y2\nM2\n")

    result = asyncio.run(gateway.stream_program(program))

    assert result.success is True
    assert result.command_count == 4
    assert result.accepted_command_count == 4
    assert connection.sent == ["?", "G21\n", "G90\n", "G0 X1 Y2\n", "M2\n"]


def test_resumed_program_lifts_repositions_and_restores_pen_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = ProgramWebSocketConnection()
    monkeypatch.setattr("plotterapp_api.fluidnc.connect", lambda *_args, **_kwargs: connection)
    gateway = FluidNCGateway(tmp_path / "fluidnc.json")
    profile = MachineProfile()
    program = _valid_program(
        "G21\nG90\nG0 X10 Y20 F6000\nG1 Z0 F400\n"
        "G1 X15 Y25 F1800\nG1 X20 Y30 F1800\nG1 Z5 F900\n"
    )

    result = asyncio.run(gateway.stream_program(program, profile=profile, start_line=6))

    assert result.success is True
    assert connection.sent[:10] == [
        "?",
        "G21\n",
        "G90\n",
        "G17\n",
        "G94\n",
        "G1 Z5 F900\n",
        "G4 P0.08\n",
        "G0 X15 Y25 F6000\n",
        "G1 Z0 F400\n",
        "G4 P0.12\n",
    ]
    assert connection.sent[10:] == ["G1 X20 Y30 F1800\n", "G1 Z5 F900\n"]


def test_streamed_program_holds_on_controller_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    connection = ProgramWebSocketConnection(fail_after_commands=2)
    monkeypatch.setattr("plotterapp_api.fluidnc.connect", lambda *_args, **_kwargs: connection)
    gateway = FluidNCGateway(tmp_path / "fluidnc.json")
    program = _valid_program("G21\nG90\nG0 X1 Y2\n", sha256="b" * 64)

    result = asyncio.run(gateway.stream_program(program))

    assert result.success is False
    assert result.accepted_command_count == 1
    assert connection.sent == ["?", "G21\n", "G90\n", "!"]


def test_sd_project_uploads_passes_in_priority_order_and_starts_combined_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    gateway = FluidNCGateway(tmp_path / "fluidnc.json")
    uploaded: list[tuple[str, bytes]] = []
    directories: list[str] = []

    async def mkdir(_settings: FluidNCSettings, path: str) -> None:
        directories.append(path)

    async def put(_settings: FluidNCSettings, path: str, content: bytes) -> None:
        uploaded.append((path, content))

    async def start(_settings: FluidNCSettings, path: str) -> list[str]:
        assert path.endswith("/run-all.nc")
        return ["<Idle|MPos:0,0,0>", "ok"]

    monkeypatch.setattr(gateway, "_webdav_mkdir", mkdir)
    monkeypatch.setattr(gateway, "_webdav_put", put)
    monkeypatch.setattr(gateway, "_start_sd_program", start)
    first = _valid_program("G21\nM2\n").model_copy(update={"filename": "01-black.nc"})
    second = _valid_program("G21\nM2\n", sha256="b" * 64).model_copy(
        update={"filename": "02-cyan.nc"}
    )
    combined = _valid_program("G21\nM0 (CHANGE PEN)\nM2\n", sha256="c" * 64).model_copy(
        update={"filename": "combined.nc"}
    )

    result = asyncio.run(
        gateway.store_and_run_project(
            "project-1234567890",
            "Priority Test",
            [("pass-black", "Black", first), ("pass-cyan", "Cyan", second)],
            combined,
        )
    )

    assert directories == ["/plotbox", "/plotbox/priority-test-project-1234"]
    assert [path.rsplit("/", 1)[-1] for path, _ in uploaded] == [
        "01-black.nc",
        "02-cyan.nc",
        "run-all.nc",
    ]
    assert [item.pass_id for item in result.passes] == ["pass-black", "pass-cyan"]
    assert [item.priority for item in result.passes] == [1, 2]
    assert result.success is True


def test_fluidnc_api_uses_gateway_without_application_action_confirmation() -> None:
    gateway = FakeFluidNCGateway()
    with TestClient(create_app(fluidnc_gateway=gateway)) as client:
        settings = client.get("/api/fluidnc/settings")
        assert settings.status_code == 200
        saved = client.put(
            "/api/fluidnc/settings",
            json={
                "schema_version": 1,
                "host": "plotter.local",
                "port": 81,
                "tls": False,
                "command_timeout_seconds": 12,
            },
        )
        assert saved.status_code == 200
        assert gateway.current.host == "plotter.local"

        identify = client.post("/api/fluidnc/actions", json={"action": "identify"})
        assert identify.status_code == 200
        assert identify.json()["controller_state"] == "Idle"

        reset = client.post(
            "/api/fluidnc/actions",
            json={"action": "alarm_reset"},
        )
        assert reset.status_code == 200
        assert gateway.requests[-1] == FluidNCActionRequest(action="alarm_reset")

        jog = client.post(
            "/api/fluidnc/actions",
            json={
                "action": "jog",
                "axis": "X",
                "distance_mm": 260,
                "feed_mm_min": 12_000,
            },
        )
        assert jog.status_code == 200
        commissioning = client.post(
            "/api/fluidnc/actions",
            json={
                "action": "commissioning_test",
                "test": {
                    "test_id": "registration",
                },
            },
        )
        assert commissioning.status_code == 200
        assert gateway.requests[-1].test is not None
        assert gateway.requests[-1].test.test_id == "registration"
        calibration = client.post(
            "/api/fluidnc/calibration/axis",
            json={
                "current_steps_per_mm": 80,
                "commanded_distance_mm": 100,
                "measured_distance_mm": 98,
            },
        )
        assert calibration.status_code == 200
        assert calibration.json()["corrected_steps_per_mm"] == pytest.approx(81.632653)
        skew = client.post(
            "/api/fluidnc/calibration/skew",
            json={
                "square_width_mm": 100,
                "square_height_mm": 100,
                "rising_diagonal_mm": 142,
                "falling_diagonal_mm": 140.8,
            },
        )
        assert skew.status_code == 200, skew.text
        assert skew.json()["skew_calibration"]["enabled"] is True
        assert gateway.current.skew_calibration.enabled is True


def test_project_send_endpoint_streams_only_a_fresh_validated_export(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    gateway = FakeFluidNCGateway()
    with TestClient(create_app(fluidnc_gateway=gateway)) as client:
        project = client.post("/api/projects", json={"name": "Send test"}).json()
        project_id = project["project_id"]
        generated = client.post(f"/api/projects/{project_id}/generate", json={"quality": "draft"})
        assert generated.status_code == 200, generated.text
        planned = client.post(f"/api/projects/{project_id}/plan")
        assert planned.status_code == 200, planned.text

        rejected = client.post(
            f"/api/projects/{project_id}/send/gcode",
            json={"filename": "combined.nc", "confirmed": False},
        )
        assert rejected.status_code == 422
        assert gateway.programs == []

        sent = client.post(
            f"/api/projects/{project_id}/send/gcode",
            json={"filename": "combined.nc", "confirmed": True},
        )
        assert sent.status_code == 200, sent.text
        assert sent.json()["success"] is True
        assert gateway.programs[-1].filename == "combined.nc"
        assert gateway.programs[-1].validation.valid is True
        assert gateway.program_options[-1][1] == 1
        uncorrected_text = gateway.programs[-1].text

        resumed = client.post(
            f"/api/projects/{project_id}/send/gcode",
            json={"filename": "combined.nc", "start_line": 10, "confirmed": True},
        )
        assert resumed.status_code == 200, resumed.text
        assert gateway.program_options[-1][1] == 10

        gateway.current = gateway.current.model_copy(
            update={
                "skew_calibration": SkewCalibration(
                    enabled=True,
                    axis_angle_degrees=89.5,
                )
            }
        )
        corrected = client.post(
            f"/api/projects/{project_id}/send/gcode",
            json={"filename": "combined.nc", "confirmed": True},
        )
        assert corrected.status_code == 200, corrected.text
        assert gateway.programs[-1].text != uncorrected_text
        assert gateway.programs[-1].validation.valid is True

        unsafe_profile = {
            "schema_version": 1,
            "profile_id": "unsafe-z",
            "name": "Unsafe Z",
            "dialect": "fluidnc-grbl",
            "work_width_mm": 430,
            "work_height_mm": 310,
            "origin_corner": "lower-left",
            "invert_x": False,
            "invert_y": False,
            "precision_decimals": 3,
            "motion": {
                "travel_command": "G0",
                "draw_command": "G1",
                "draw_feed_mm_min": 1800,
                "travel_feed_mm_min": 6000,
            },
            "pen_actuator": {
                "kind": "z_axis",
                "up_mm": 5,
                "down_mm": 0,
                "lift_feed_mm_min": 900,
                "lower_feed_mm_min": 400,
                "dwell_after_up_ms": 80,
                "dwell_after_down_ms": 120,
            },
            "park": {"enabled": False, "x_mm": 0, "y_mm": 0},
            "macros": {"header": ["G21", "G90"], "pause": "M0 ({message})", "footer": ["M2"]},
            "allowed_commands": ["G0", "G1", "G21", "G90", "M0", "M2"],
        }
        unsafe = client.post(
            f"/api/projects/{project_id}/send/gcode",
            json={"filename": "combined.nc", "confirmed": True, "profile": unsafe_profile},
        )
        assert unsafe.status_code == 422
        assert "controller-safe Z range" in unsafe.json()["detail"]

        missing = client.post(
            f"/api/projects/{project_id}/send/gcode",
            json={"filename": "untrusted.nc", "confirmed": True},
        )
        assert missing.status_code == 422


def test_project_sd_endpoint_regenerates_all_passes_in_configured_order(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("PLOTTERAPP_PROJECTS_ROOT", str(tmp_path))
    gateway = FakeFluidNCGateway()
    with TestClient(create_app(fluidnc_gateway=gateway)) as client:
        project = client.post("/api/projects", json={"name": "SD queue"}).json()
        project_id = project["project_id"]
        generated = client.post(
            f"/api/projects/{project_id}/generate", json={"quality": "draft"}
        )
        assert generated.status_code == 200, generated.text
        planned = client.post(f"/api/projects/{project_id}/plan")
        assert planned.status_code == 200, planned.text

        rejected = client.post(
            f"/api/projects/{project_id}/send/fluidnc-sd", json={"confirmed": False}
        )
        assert rejected.status_code == 422
        assert gateway.sd_projects == []

        sent = client.post(
            f"/api/projects/{project_id}/send/fluidnc-sd", json={"confirmed": True}
        )
        assert sent.status_code == 200, sent.text
        payload = sent.json()
        expected_ids = [item["pass_id"] for item in planned.json()["passes"]]
        assert [item["pass_id"] for item in payload["passes"]] == expected_ids
        assert [item["priority"] for item in payload["passes"]] == list(
            range(1, len(expected_ids) + 1)
        )
        assert payload["run_path"].endswith("/run-all.nc")
        _, _, pass_programs, combined = gateway.sd_projects[-1]
        assert all(program.validation.valid for _, _, program in pass_programs)
        assert combined.filename == "combined.nc"
        assert "M0 (CHANGE PEN TO" in combined.text
