from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from plotterapp_api.fluidnc import (
    AxisCalibrationRequest,
    FluidNCActionRequest,
    FluidNCActionResult,
    FluidNCGateway,
    FluidNCSettings,
    build_action_frames,
    calculate_axis_calibration,
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


class FakeFluidNCGateway:
    def __init__(self) -> None:
        self.current = FluidNCSettings()
        self.requests: list[FluidNCActionRequest] = []

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


def test_fluidnc_action_builder_enforces_confirmation_and_motion_bounds() -> None:
    with pytest.raises(ValueError, match="explicit motion confirmation"):
        build_action_frames(FluidNCActionRequest(action="home", axis="X"))
    with pytest.raises(ValueError, match="limited to 25 mm"):
        build_action_frames(
            FluidNCActionRequest(
                action="jog",
                confirmed=True,
                axis="X",
                distance_mm=26,
                feed_mm_min=500,
            )
        )

    frames, summaries = build_action_frames(
        FluidNCActionRequest(
            action="jog",
            confirmed=True,
            axis="Y",
            distance_mm=-5,
            feed_mm_min=400,
        )
    )
    assert frames == ["$J=G91 G21 F400 Y-5\n"]
    assert summaries == ["$J=G91 G21 F400 Y-5"]

    frames, _ = build_action_frames(
        FluidNCActionRequest(
            action="pen_test",
            confirmed=True,
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
    test = FluidNCCommissioningTestRequest(test_id=test_id, confirmed=True)
    frames, summary = build_action_frames(
        FluidNCActionRequest(action="commissioning_test", confirmed=True, test=test)
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


def test_commissioning_pattern_requires_both_confirmations_and_valid_area() -> None:
    test = FluidNCCommissioningTestRequest(test_id="scale_grid", confirmed=True)
    with pytest.raises(ValueError, match="explicit motion confirmation"):
        build_action_frames(FluidNCActionRequest(action="commissioning_test", test=test))

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
    test = FluidNCCommissioningTestRequest(test_id="scale_grid", confirmed=True)

    result = asyncio.run(
        gateway.execute(
            FluidNCActionRequest(action="commissioning_test", confirmed=True, test=test)
        )
    )

    assert result.success is False
    assert connection.sent == ["G21\n", "!"]


def test_fluidnc_api_uses_gateway_and_keeps_safety_validation() -> None:
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

        unconfirmed = client.post(
            "/api/fluidnc/actions",
            json={
                "action": "jog",
                "axis": "X",
                "distance_mm": 5,
                "feed_mm_min": 500,
            },
        )
        assert unconfirmed.status_code == 422
        assert gateway.requests == [FluidNCActionRequest(action="identify")]

        jog = client.post(
            "/api/fluidnc/actions",
            json={
                "action": "jog",
                "confirmed": True,
                "axis": "X",
                "distance_mm": 5,
                "feed_mm_min": 500,
            },
        )
        assert jog.status_code == 200
        commissioning = client.post(
            "/api/fluidnc/actions",
            json={
                "action": "commissioning_test",
                "confirmed": True,
                "test": {
                    "test_id": "registration",
                    "confirmed": True,
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
