import { NumericInput } from "./NumericInput";
import { useEffect, useMemo, useState } from "react";

import { api } from "./api";
import type {
  AxisCalibrationResult,
  FluidNCActionRequest,
  FluidNCCommissioningTestId,
  FluidNCCommissioningTestRequest,
  FluidNCActionResult,
  FluidNCSettings,
} from "./types";

const DEFAULT_SETTINGS: FluidNCSettings = {
  schema_version: 1,
  host: "fluidnc.local",
  port: 81,
  tls: false,
  command_timeout_seconds: 15,
  safe_z_min_mm: -10,
  safe_z_max_mm: 0,
  pen_up_z_mm: 0,
  pen_down_z_mm: -5,
};

const COMMISSIONING_TEST_DEFINITIONS: Record<
  FluidNCCommissioningTestId,
  { label: string; description: string; field: string }
> = {
  scale_grid: {
    label: "Scale grid",
    description: "Square grid for checking commanded distances on both axes.",
    field: "spacing",
  },
  circle_arc: {
    label: "Circle and arc",
    description: "Full circle plus quarter arcs for roundness and interpolation checks.",
    field: "none",
  },
  diagonal_skew: {
    label: "Diagonal / skew",
    description: "Crossing diagonals and reference edges for squareness and skew.",
    field: "none",
  },
  backlash_ladder: {
    label: "Backlash ladder",
    description: "Alternating-direction ladders to reveal lost motion on X and Y.",
    field: "step",
  },
  speed_test: {
    label: "Speed test",
    description: "Repeated lines at a feed-rate range for finish and missed-step checks.",
    field: "speed",
  },
  z_depth_ladder: {
    label: "Pen pressure / Z-depth ladder",
    description: "Repeated lines at progressively different absolute Z depths.",
    field: "depth",
  },
  lift_delay: {
    label: "Lift-delay test",
    description: "Repeated strokes with increasing dwell after lifting before the next mark.",
    field: "delay",
  },
  registration: {
    label: "Registration test",
    description: "Corner and centre crosshairs for repeatability and alignment checks.",
    field: "none",
  },
  pen_swatch: {
    label: "Pen swatch sheet",
    description: "Repeated outlined swatches to compare ink flow with the current pen.",
    field: "none",
  },
  line_spacing: {
    label: "Line-spacing test",
    description: "Groups of parallel lines with progressively wider spacing.",
    field: "spacing",
  },
  hatch_density: {
    label: "Hatch-density test",
    description: "Outlined blocks with progressively denser hatch lines.",
    field: "spacing",
  },
};

const DEFAULT_COMMISSIONING_TEST: FluidNCCommissioningTestRequest = {
  test_id: "scale_grid",
  origin_x_mm: 20,
  origin_y_mm: 20,
  width_mm: 100,
  height_mm: 100,
  feed_mm_min: 600,
  speed_start_mm_min: 300,
  speed_end_mm_min: 1800,
  spacing_mm: 8,
  step_mm: 5,
  steps: 5,
  z_up_mm: 5,
  z_down_mm: 0,
  depth_start_mm: 0,
  depth_end_mm: -1,
  delay_step_ms: 100,
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected controller error";
}

type Axis = "X" | "Y" | "Z";
type AxisPositions = Record<Axis, number | null>;

const EMPTY_AXIS_POSITIONS: AxisPositions = { X: null, Y: null, Z: null };

function parseAxisPositions(
  lines: string[],
): { positions: AxisPositions; coordinateType: "MPos" | "WPos" } | null {
  const status = lines.join(" ");
  const machineMatch = status.match(
    /MPos:\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
  );
  const workMatch = status.match(
    /WPos:\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/i,
  );
  const match = machineMatch ?? workMatch;
  if (!match) return null;
  return {
    positions: { X: Number(match[1]), Y: Number(match[2]), Z: Number(match[3]) },
    coordinateType: machineMatch ? "MPos" : "WPos",
  };
}

function formatAxisPosition(value: number | null): string {
  return value === null ? "—" : value.toFixed(2);
}

export function PlotterSetup() {
  const [settings, setSettings] = useState<FluidNCSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState<string | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FluidNCActionResult | null>(null);
  const [jogAxis, setJogAxis] = useState<"X" | "Y" | "Z">("X");
  const [jogDistance, setJogDistance] = useState(5);
  const [jogFeed, setJogFeed] = useState(500);
  const [axisPositions, setAxisPositions] = useState<AxisPositions>(EMPTY_AXIS_POSITIONS);
  const [positionType, setPositionType] = useState<"MPos" | "WPos" | null>(null);
  const [positionBusy, setPositionBusy] = useState(false);
  const [controllerState, setControllerState] = useState<string | null>(null);
  const [statusUpdatedAt, setStatusUpdatedAt] = useState<Date | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [penUp, setPenUp] = useState(5);
  const [penDown, setPenDown] = useState(0);
  const [penFeed, setPenFeed] = useState(400);
  const [commissioningTest, setCommissioningTest] = useState<FluidNCCommissioningTestRequest>(
    DEFAULT_COMMISSIONING_TEST,
  );
  const [currentSteps, setCurrentSteps] = useState(80);
  const [commandedDistance, setCommandedDistance] = useState(100);
  const [measuredDistance, setMeasuredDistance] = useState(100);
  const [calibration, setCalibration] = useState<AxisCalibrationResult | null>(null);

  useEffect(() => {
    void api
      .getFluidNCSettings()
      .then(setSettings)
      .catch((reason: unknown) => setError(messageFor(reason)))
      .finally(() => setBusy(null));
  }, []);

  const endpoint = useMemo(
    () => `${settings.tls ? "wss" : "ws"}://${settings.host}:${settings.port}/`,
    [settings],
  );

  const runAction = async (label: string, request: FluidNCActionRequest) => {
    setBusy(label);
    setError(null);
    try {
      const actionResult = await api.runFluidNCAction(request);
      const parsed = parseAxisPositions(actionResult.response_lines);
      if (parsed) {
        setAxisPositions(parsed.positions);
        setPositionType(parsed.coordinateType);
      }
      if (actionResult.controller_state) setControllerState(actionResult.controller_state);
      setResult(actionResult);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(null);
    }
  };

  const refreshPosition = async () => {
    setPositionBusy(true);
    setError(null);
    try {
      const statusResult = await api.runFluidNCAction({ action: "status" });
      const parsed = parseAxisPositions(statusResult.response_lines);
      if (parsed) {
        setAxisPositions(parsed.positions);
        setPositionType(parsed.coordinateType);
      }
      if (statusResult.controller_state) setControllerState(statusResult.controller_state);
      setStatusUpdatedAt(new Date());
      setStatusError(null);
      setResult(statusResult);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setPositionBusy(false);
    }
  };

  useEffect(() => {
    let disposed = false;
    let polling = false;
    const pollStatus = async () => {
      if (disposed || polling || busy !== null || positionBusy) return;
      polling = true;
      try {
        const statusResult = await api.runFluidNCAction({ action: "status" });
        if (disposed) return;
        const parsed = parseAxisPositions(statusResult.response_lines);
        if (parsed) {
          setAxisPositions(parsed.positions);
          setPositionType(parsed.coordinateType);
        }
        setControllerState(statusResult.controller_state ?? "Unknown");
        setStatusUpdatedAt(new Date());
        setStatusError(null);
      } catch (reason) {
        if (!disposed) setStatusError(messageFor(reason));
      } finally {
        polling = false;
      }
    };
    const timer = window.setInterval(() => void pollStatus(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [busy, positionBusy]);

  const selectedCommissioningTest = COMMISSIONING_TEST_DEFINITIONS[commissioningTest.test_id];
  const jogReady =
    Number.isFinite(jogDistance) && jogDistance > 0 && Number.isFinite(jogFeed) && jogFeed > 0;
  const updateCommissioningTest = (changes: Partial<FluidNCCommissioningTestRequest>): void => {
    setCommissioningTest((current) => ({ ...current, ...changes }));
  };

  const saveSettings = async () => {
    setBusy("save-settings");
    setError(null);
    try {
      setSettings(await api.saveFluidNCSettings(settings));
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(null);
    }
  };

  const calculate = async () => {
    setBusy("calibration");
    setError(null);
    try {
      setCalibration(
        await api.calculateAxisCalibration(currentSteps, commandedDistance, measuredDistance),
      );
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="plotter-setup" aria-labelledby="plotter-setup-heading">
      <div className="setup-heading">
        <div>
          <p className="eyebrow">GUARDED COMMISSIONING</p>
          <h2 id="plotter-setup-heading">FluidNC plotter setup</h2>
          <p>
            The server connects to FluidNC over WebSocket. Motion tests are deliberately small,
            typed, and confirmation-gated.
          </p>
        </div>
        <div className="setup-heading-actions">
          <button
            className="danger-button"
            type="button"
            disabled={busy !== null}
            onClick={() => void runAction("alarm-reset", { action: "alarm_reset" })}
          >
            {busy === "alarm-reset" ? "Resetting alarm…" : "Reset FluidNC alarm"}
          </button>
          <button
            className="hold-button"
            type="button"
            disabled={busy === "loading" || busy === "hold"}
            onClick={() => void runAction("hold", { action: "hold" })}
          >
            Feed hold (!)
          </button>
        </div>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <strong>Controller action blocked</strong>
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            aria-label="Dismiss controller error"
          >
            ×
          </button>
        </div>
      )}

      <div className="setup-grid">
        <section className="setup-card jog-console-card">
          <div className="jog-console-copy">
            <p className="eyebrow">MANUAL JOG</p>
            <h3>Axis controls</h3>
            <p>
              Use the directional pad for small relative moves. X/Y moves are on the left; Z is
              isolated on the right.
            </p>
            <div className="jog-axis-selector" aria-label="Jog axis selection">
              {(["X", "Y", "Z"] as const).map((axis) => (
                <button
                  key={axis}
                  className={jogAxis === axis ? "selected" : ""}
                  type="button"
                  aria-pressed={jogAxis === axis}
                  onClick={() => setJogAxis(axis)}
                >
                  {axis} axis
                </button>
              ))}
            </div>
          </div>

          <div className="jog-pad-wrap">
            <div className="jog-pad" aria-label="FluidNC XY jog pad">
              <button
                className="jog-direction jog-y-positive"
                type="button"
                aria-label="Jog Y positive"
                disabled={busy !== null || !jogReady}
                onClick={() =>
                  void runAction("jog", {
                    action: "jog",
                    axis: "Y",
                    distance_mm: Math.abs(jogDistance),
                    feed_mm_min: jogFeed,
                  })
                }
              >
                Y+
              </button>
              <button
                className="jog-direction jog-x-negative"
                type="button"
                aria-label="Jog X negative"
                disabled={busy !== null || !jogReady}
                onClick={() =>
                  void runAction("jog", {
                    action: "jog",
                    axis: "X",
                    distance_mm: -Math.abs(jogDistance),
                    feed_mm_min: jogFeed,
                  })
                }
              >
                X−
              </button>
              <div className="jog-pad-center" aria-hidden="true">
                <span>{jogAxis}</span>
                <small>{Math.abs(jogDistance)} mm</small>
              </div>
              <button
                className="jog-direction jog-x-positive"
                type="button"
                aria-label="Jog X positive"
                disabled={busy !== null || !jogReady}
                onClick={() =>
                  void runAction("jog", {
                    action: "jog",
                    axis: "X",
                    distance_mm: Math.abs(jogDistance),
                    feed_mm_min: jogFeed,
                  })
                }
              >
                X+
              </button>
              <button
                className="jog-direction jog-y-negative"
                type="button"
                aria-label="Jog Y negative"
                disabled={busy !== null || !jogReady}
                onClick={() =>
                  void runAction("jog", {
                    action: "jog",
                    axis: "Y",
                    distance_mm: -Math.abs(jogDistance),
                    feed_mm_min: jogFeed,
                  })
                }
              >
                Y−
              </button>
            </div>
            <div className="z-jog-controls">
              <span>Z axis</span>
              <button
                type="button"
                aria-label="Jog Z positive"
                disabled={busy !== null || !jogReady}
                onClick={() =>
                  void runAction("jog", {
                    action: "jog",
                    axis: "Z",
                    distance_mm: Math.abs(jogDistance),
                    feed_mm_min: jogFeed,
                  })
                }
              >
                Z+
              </button>
              <button
                type="button"
                aria-label="Jog Z negative"
                disabled={busy !== null || !jogReady}
                onClick={() =>
                  void runAction("jog", {
                    action: "jog",
                    axis: "Z",
                    distance_mm: -Math.abs(jogDistance),
                    feed_mm_min: jogFeed,
                  })
                }
              >
                Z−
              </button>
            </div>
          </div>

          <div className="jog-console-settings">
            <div className="axis-position-card" aria-label="Current axis positions">
              <div className="axis-position-heading">
                <span>Live controller status</span>
                <button
                  type="button"
                  onClick={() => void refreshPosition()}
                  disabled={positionBusy || busy !== null}
                >
                  {positionBusy ? "Reading…" : "Refresh"}
                </button>
              </div>
              <div className="axis-position-values" aria-live="polite">
                {(["X", "Y", "Z"] as const).map((axis) => (
                  <div key={axis}>
                    <span>{axis}</span>
                    <strong>{formatAxisPosition(axisPositions[axis])}</strong>
                    <small>mm</small>
                  </div>
                ))}
              </div>
              <small className="axis-position-source">
                {positionType
                  ? `${positionType === "MPos" ? "Machine" : "Work"} coordinates`
                  : "No status read yet"}
              </small>
              <div
                className={`controller-state ${
                  controllerState === "Alarm" ? "alarm" : controllerState === "Idle" ? "idle" : ""
                }`}
                aria-live="polite"
              >
                <strong>{controllerState ?? "Unknown"}</strong>
                <span>
                  {statusError
                    ? `Status unavailable: ${statusError}`
                    : statusUpdatedAt
                      ? `Updated ${statusUpdatedAt.toLocaleTimeString()}`
                      : "Polling every 2 seconds"}
                </span>
              </div>
            </div>
            <label>
              Step distance mm
              <NumericInput
                aria-label="Jog distance"
                type="number"
                step="0.1"
                value={jogDistance}
                onChange={(event) => setJogDistance(Number(event.target.value))}
              />
            </label>
            <label>
              Jog speed mm/min
              <NumericInput
                aria-label="Jog feed"
                type="number"
                step="1"
                value={jogFeed}
                onChange={(event) => setJogFeed(Number(event.target.value))}
              />
              <span className="speed-value">{jogFeed} mm/min</span>
            </label>
            <div className="speed-presets" aria-label="Jog speed presets">
              {[100, 500, 1000, 2000].map((speed) => (
                <button
                  key={speed}
                  className={jogFeed === speed ? "selected" : ""}
                  type="button"
                  aria-label={`Set jog speed to ${speed} mm/min`}
                  aria-pressed={jogFeed === speed}
                  onClick={() => setJogFeed(speed)}
                >
                  {speed}
                </button>
              ))}
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={busy !== null || !jogReady}
              onClick={() =>
                void runAction("jog", {
                  action: "jog",
                  axis: jogAxis,
                  distance_mm: Math.abs(jogDistance),
                  feed_mm_min: jogFeed,
                })
              }
            >
              {busy === "jog" ? "Jogging…" : "Run guarded jog"}
            </button>
          </div>
        </section>

        <section className="setup-card">
          <p className="eyebrow">CONNECTION</p>
          <h3>FluidNC endpoint</h3>
          <label>
            Hostname or IP
            <input
              aria-label="FluidNC hostname"
              value={settings.host}
              onChange={(event) => setSettings({ ...settings, host: event.target.value })}
            />
          </label>
          <div className="field-row">
            <label>
              WebSocket port
              <NumericInput
                aria-label="FluidNC WebSocket port"
                type="number"
                min="1"
                max="65535"
                value={settings.port}
                onChange={(event) => setSettings({ ...settings, port: Number(event.target.value) })}
              />
            </label>
            <label>
              Timeout seconds
              <NumericInput
                aria-label="FluidNC command timeout"
                type="number"
                min="1"
                max="120"
                value={settings.command_timeout_seconds}
                onChange={(event) =>
                  setSettings({ ...settings, command_timeout_seconds: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings.tls}
              onChange={(event) => setSettings({ ...settings, tls: event.target.checked })}
            />
            FluidNC itself uses TLS (wss)
          </label>
          <div className="field-row">
            <label>
              Safe Z minimum
              <NumericInput
                aria-label="Safe Z minimum"
                type="number"
                step="0.1"
                value={settings.safe_z_min_mm}
                onChange={(event) =>
                  setSettings({ ...settings, safe_z_min_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Safe Z maximum
              <NumericInput
                aria-label="Safe Z maximum"
                type="number"
                step="0.1"
                value={settings.safe_z_max_mm}
                onChange={(event) =>
                  setSettings({ ...settings, safe_z_max_mm: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <div className="field-row">
            <label>
              Plot pen-up Z
              <NumericInput
                aria-label="Plot pen up Z"
                type="number"
                step="0.1"
                value={settings.pen_up_z_mm}
                onChange={(event) =>
                  setSettings({ ...settings, pen_up_z_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Plot pen-down Z
              <NumericInput
                aria-label="Plot pen down Z"
                type="number"
                step="0.1"
                value={settings.pen_down_z_mm}
                onChange={(event) =>
                  setSettings({ ...settings, pen_down_z_mm: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <p className="field-help">
            Used to create the editor's default plot profile and to block direct sends outside this
            controller-safe Z envelope. For this configured machine, use the FluidNC Z range −10 to
            0.
          </p>
          <code className="endpoint-preview">{endpoint}</code>
          <div className="action-row">
            <button type="button" disabled={busy !== null} onClick={() => void saveSettings()}>
              {busy === "save-settings" ? "Saving…" : "Save connection"}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={busy !== null}
              onClick={() => void runAction("identify", { action: "identify" })}
            >
              {busy === "identify" ? "Connecting…" : "Test connection"}
            </button>
          </div>
          <p className="field-help">
            Behind Home Assistant HTTPS, this connection still originates inside the add-on, so the
            browser never opens an insecure mixed-content WebSocket.
          </p>
        </section>

        <section className="setup-card">
          <p className="eyebrow">READ-ONLY CHECKS</p>
          <h3>Controller diagnostics</h3>
          <p>
            Run these before enabling motion. The limit check exits FluidNC limit-reporting mode.
          </p>
          <div className="diagnostic-actions">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void runAction("status", { action: "status" })}
            >
              Machine state
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void runAction("modal", { action: "modal" })}
            >
              Active G-code modes
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void runAction("config", { action: "config" })}
            >
              Read configuration
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void runAction("limits", { action: "limits" })}
            >
              Check limit switches
            </button>
          </div>
        </section>

        <section className="setup-card motion-card">
          <p className="eyebrow">LIMITS AND HOME</p>
          <h3>Home plotter axes</h3>
          <p>Check the limit switches and homing direction before starting either homing cycle.</p>
          <div className="home-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busy !== null}
              onClick={() => void runAction("home-xy", { action: "home", axis: "XY" })}
            >
              {busy === "home-xy" ? "Homing X/Y…" : "Home X/Y"}
            </button>
            <button
              className="manual-action-button"
              type="button"
              disabled={busy !== null}
              onClick={() => void runAction("home-z", { action: "home", axis: "Z" })}
            >
              {busy === "home-z" ? "Homing Z…" : "Home Z after pen install"}
            </button>
          </div>
          <p className="field-help">
            XY homes together. Install and secure the pen before manually homing Z so the pen
            position is referenced correctly.
          </p>
        </section>

        <section className="setup-card motion-card">
          <p className="eyebrow">PEN ACTUATOR</p>
          <h3>Test absolute Z lift</h3>
          <p>The cycle always finishes at the configured pen-up Z value.</p>
          <div className="field-row three">
            <label>
              Pen up Z
              <NumericInput
                aria-label="Test pen up Z"
                type="number"
                min="-20"
                max="20"
                step="0.1"
                value={penUp}
                onChange={(event) => setPenUp(Number(event.target.value))}
              />
            </label>
            <label>
              Pen down Z
              <NumericInput
                aria-label="Test pen down Z"
                type="number"
                min="-20"
                max="20"
                step="0.1"
                value={penDown}
                onChange={(event) => setPenDown(Number(event.target.value))}
              />
            </label>
            <label>
              Feed mm/min
              <NumericInput
                aria-label="Test pen feed"
                type="number"
                min="1"
                max="1500"
                value={penFeed}
                onChange={(event) => setPenFeed(Number(event.target.value))}
              />
            </label>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null || penUp === penDown}
            onClick={() =>
              void runAction("pen_test", {
                action: "pen_test",
                feed_mm_min: penFeed,
                pen_up_mm: penUp,
                pen_down_mm: penDown,
              })
            }
          >
            Run up → down → up test
          </button>
        </section>

        <section className="setup-card motion-card commissioning-card">
          <p className="eyebrow">CALIBRATION TEST LIBRARY</p>
          <h3>Run a named test pattern</h3>
          <p>
            These patterns are generated and sent by the server as one bounded, allowlisted motion
            sequence. They never write FluidNC settings or send project G-code.
          </p>
          <label>
            Calibration test
            <select
              aria-label="Calibration test"
              value={commissioningTest.test_id}
              onChange={(event) => {
                updateCommissioningTest({
                  test_id: event.target.value as FluidNCCommissioningTestId,
                });
              }}
            >
              {Object.entries(COMMISSIONING_TEST_DEFINITIONS).map(([testId, definition]) => (
                <option key={testId} value={testId}>
                  {definition.label}
                </option>
              ))}
            </select>
          </label>
          <p className="field-help">{selectedCommissioningTest.description}</p>
          <div className="field-row three">
            <label>
              Origin X mm
              <NumericInput
                aria-label="Test origin X"
                type="number"
                min="-500"
                max="500"
                step="0.1"
                value={commissioningTest.origin_x_mm}
                onChange={(event) =>
                  updateCommissioningTest({ origin_x_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Origin Y mm
              <NumericInput
                aria-label="Test origin Y"
                type="number"
                min="-500"
                max="500"
                step="0.1"
                value={commissioningTest.origin_y_mm}
                onChange={(event) =>
                  updateCommissioningTest({ origin_y_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Width mm
              <NumericInput
                aria-label="Test width"
                type="number"
                min="1"
                max="180"
                step="1"
                value={commissioningTest.width_mm}
                onChange={(event) =>
                  updateCommissioningTest({ width_mm: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <div className="field-row three">
            <label>
              Height mm
              <NumericInput
                aria-label="Test height"
                type="number"
                min="1"
                max="180"
                step="1"
                value={commissioningTest.height_mm}
                onChange={(event) =>
                  updateCommissioningTest({ height_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Drawing feed mm/min
              <NumericInput
                aria-label="Test drawing feed"
                type="number"
                min="60"
                max="3000"
                value={commissioningTest.feed_mm_min}
                onChange={(event) =>
                  updateCommissioningTest({ feed_mm_min: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Rows / steps
              <NumericInput
                aria-label="Test rows or steps"
                type="number"
                min="2"
                max="12"
                step="1"
                value={commissioningTest.steps}
                onChange={(event) => updateCommissioningTest({ steps: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="field-row three">
            <label>
              Pen up Z
              <NumericInput
                aria-label="Calibration pen up Z"
                type="number"
                min="-20"
                max="20"
                step="0.1"
                value={commissioningTest.z_up_mm}
                onChange={(event) =>
                  updateCommissioningTest({ z_up_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Pen down Z
              <NumericInput
                aria-label="Calibration pen down Z"
                type="number"
                min="-20"
                max="20"
                step="0.1"
                value={commissioningTest.z_down_mm}
                onChange={(event) =>
                  updateCommissioningTest({ z_down_mm: Number(event.target.value) })
                }
              />
            </label>
            <label>
              Base spacing mm
              <NumericInput
                aria-label="Calibration base spacing"
                type="number"
                min="0.5"
                max="20"
                step="0.1"
                value={commissioningTest.spacing_mm}
                onChange={(event) =>
                  updateCommissioningTest({ spacing_mm: Number(event.target.value) })
                }
              />
            </label>
          </div>
          {selectedCommissioningTest.field === "step" && (
            <label>
              Direction step mm
              <NumericInput
                aria-label="Backlash direction step"
                type="number"
                min="0.1"
                max="25"
                step="0.1"
                value={commissioningTest.step_mm}
                onChange={(event) =>
                  updateCommissioningTest({ step_mm: Number(event.target.value) })
                }
              />
            </label>
          )}
          {selectedCommissioningTest.field === "speed" && (
            <div className="field-row two">
              <label>
                Slow feed mm/min
                <NumericInput
                  aria-label="Speed test starting feed"
                  type="number"
                  min="60"
                  max="3000"
                  value={commissioningTest.speed_start_mm_min}
                  onChange={(event) =>
                    updateCommissioningTest({ speed_start_mm_min: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Fast feed mm/min
                <NumericInput
                  aria-label="Speed test ending feed"
                  type="number"
                  min="60"
                  max="3000"
                  value={commissioningTest.speed_end_mm_min}
                  onChange={(event) =>
                    updateCommissioningTest({ speed_end_mm_min: Number(event.target.value) })
                  }
                />
              </label>
            </div>
          )}
          {selectedCommissioningTest.field === "depth" && (
            <div className="field-row two">
              <label>
                First depth Z
                <NumericInput
                  aria-label="Z-depth ladder starting Z"
                  type="number"
                  min="-20"
                  max="20"
                  step="0.1"
                  value={commissioningTest.depth_start_mm}
                  onChange={(event) =>
                    updateCommissioningTest({ depth_start_mm: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Last depth Z
                <NumericInput
                  aria-label="Z-depth ladder ending Z"
                  type="number"
                  min="-20"
                  max="20"
                  step="0.1"
                  value={commissioningTest.depth_end_mm}
                  onChange={(event) =>
                    updateCommissioningTest({ depth_end_mm: Number(event.target.value) })
                  }
                />
              </label>
            </div>
          )}
          {selectedCommissioningTest.field === "delay" && (
            <label>
              Additional lift delay per row ms
              <NumericInput
                aria-label="Lift delay step"
                type="number"
                min="0"
                max="2000"
                step="10"
                value={commissioningTest.delay_step_ms}
                onChange={(event) =>
                  updateCommissioningTest({ delay_step_ms: Number(event.target.value) })
                }
              />
            </label>
          )}
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null}
            onClick={() =>
              void runAction("commissioning-test", {
                action: "commissioning_test",
                test: { ...commissioningTest },
              })
            }
          >
            Run {selectedCommissioningTest.label.toLowerCase()}
          </button>
        </section>

        <section className="setup-card">
          <p className="eyebrow">AXIS CALIBRATION</p>
          <h3>Calculate corrected steps/mm</h3>
          <p>Command a known distance, measure it physically, then calculate a suggested value.</p>
          <div className="field-row three">
            <label>
              Current steps/mm
              <NumericInput
                aria-label="Current steps per millimetre"
                type="number"
                min="0.001"
                value={currentSteps}
                onChange={(event) => setCurrentSteps(Number(event.target.value))}
              />
            </label>
            <label>
              Commanded mm
              <NumericInput
                aria-label="Commanded calibration distance"
                type="number"
                min="0.001"
                value={commandedDistance}
                onChange={(event) => setCommandedDistance(Number(event.target.value))}
              />
            </label>
            <label>
              Measured mm
              <NumericInput
                aria-label="Measured calibration distance"
                type="number"
                min="0.001"
                value={measuredDistance}
                onChange={(event) => setMeasuredDistance(Number(event.target.value))}
              />
            </label>
          </div>
          <button type="button" disabled={busy !== null} onClick={() => void calculate()}>
            Calculate correction
          </button>
          {calibration && (
            <div className="calibration-result" aria-live="polite">
              <span>Suggested steps/mm</span>
              <strong>{calibration.corrected_steps_per_mm.toFixed(6)}</strong>
              <small>Measured distance error: {calibration.distance_error_percent}%</small>
            </div>
          )}
          <p className="field-help">
            Plotbox does not write this value. Review and update your FluidNC config manually,
            restart the controller, then repeat the measurement.
          </p>
        </section>
      </div>

      {result && (
        <section className={`controller-result ${result.success ? "success" : "failed"}`}>
          <div>
            <p className="eyebrow">LATEST CONTROLLER RESPONSE</p>
            <h3>
              {result.test_id
                ? COMMISSIONING_TEST_DEFINITIONS[result.test_id].label
                : result.action.replace("_", " ")}
            </h3>
          </div>
          {result.controller_state && <span className="state-pill">{result.controller_state}</span>}
          <code>{result.command_summary.join(" · ")}</code>
          <pre>{result.response_lines.join("\n") || "Command sent; no text response."}</pre>
        </section>
      )}
    </section>
  );
}
