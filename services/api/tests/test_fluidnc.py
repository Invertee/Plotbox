from __future__ import annotations

import asyncio
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


def test_limit_check_always_sends_exit_realtime_command(tmp_path: Path, monkeypatch) -> None:
    connection = FakeWebSocketConnection()
    monkeypatch.setattr("plotterapp_api.fluidnc.connect", lambda *_args, **_kwargs: connection)
    gateway = FluidNCGateway(tmp_path / "fluidnc.json")

    result = asyncio.run(gateway.execute(FluidNCActionRequest(action="limits")))

    assert result.success is True
    assert result.response_lines == ["Pn:X", "ok"]
    assert connection.sent == ["$Limits\n", "!"]


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
