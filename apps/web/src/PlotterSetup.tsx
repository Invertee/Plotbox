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

export function PlotterSetup() {
  const [settings, setSettings] = useState<FluidNCSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState<string | null>("loading");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FluidNCActionResult | null>(null);
  const [homeAxis, setHomeAxis] = useState<"X" | "Y" | "Z" | "ALL">("ALL");
  const [homeConfirmed, setHomeConfirmed] = useState(false);
  const [jogAxis, setJogAxis] = useState<"X" | "Y" | "Z">("X");
  const [jogDistance, setJogDistance] = useState(5);
  const [jogFeed, setJogFeed] = useState(500);
  const [jogConfirmed, setJogConfirmed] = useState(false);
  const [penUp, setPenUp] = useState(5);
  const [penDown, setPenDown] = useState(0);
  const [penFeed, setPenFeed] = useState(400);
  const [penConfirmed, setPenConfirmed] = useState(false);
  const [commissioningTest, setCommissioningTest] = useState<FluidNCCommissioningTestRequest>(
    DEFAULT_COMMISSIONING_TEST,
  );
  const [commissioningTestConfirmed, setCommissioningTestConfirmed] = useState(false);
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
      setResult(await api.runFluidNCAction(request));
      if (request.action === "home") setHomeConfirmed(false);
      if (request.action === "jog") setJogConfirmed(false);
      if (request.action === "pen_test") setPenConfirmed(false);
      if (request.action === "commissioning_test") setCommissioningTestConfirmed(false);
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(null);
    }
  };

  const selectedCommissioningTest = COMMISSIONING_TEST_DEFINITIONS[commissioningTest.test_id];
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
        <button
          className="hold-button"
          type="button"
          disabled={busy === "loading" || busy === "hold"}
          onClick={() => void runAction("hold", { action: "hold" })}
        >
          Feed hold (!)
        </button>
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
              <input
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
              <input
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
          <p className="eyebrow">MOTION TEST</p>
          <h3>Jog one axis</h3>
          <p>Clear the carriage first. One request is limited to 25 mm and 3000 mm/min.</p>
          <div className="field-row three">
            <label>
              Axis
              <select
                aria-label="Jog axis"
                value={jogAxis}
                onChange={(event) => setJogAxis(event.target.value as "X" | "Y" | "Z")}
              >
                <option>X</option>
                <option>Y</option>
                <option>Z</option>
              </select>
            </label>
            <label>
              Distance mm
              <input
                aria-label="Jog distance"
                type="number"
                min="-25"
                max="25"
                step="0.1"
                value={jogDistance}
                onChange={(event) => setJogDistance(Number(event.target.value))}
              />
            </label>
            <label>
              Feed mm/min
              <input
                aria-label="Jog feed"
                type="number"
                min="1"
                max="3000"
                value={jogFeed}
                onChange={(event) => setJogFeed(Number(event.target.value))}
              />
            </label>
          </div>
          <label className="checkbox-row safety-confirmation">
            <input
              type="checkbox"
              checked={jogConfirmed}
              onChange={(event) => setJogConfirmed(event.target.checked)}
            />
            I have cleared the selected axis and can stop the machine.
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null || !jogConfirmed || jogDistance === 0}
            onClick={() =>
              void runAction("jog", {
                action: "jog",
                confirmed: true,
                axis: jogAxis,
                distance_mm: jogDistance,
                feed_mm_min: jogFeed,
              })
            }
          >
            Run guarded jog
          </button>
        </section>

        <section className="setup-card motion-card">
          <p className="eyebrow">LIMITS AND HOME</p>
          <h3>Home configured axes</h3>
          <p>Only use this after limit switches and homing direction have been checked.</p>
          <label>
            Homing target
            <select
              aria-label="Homing target"
              value={homeAxis}
              onChange={(event) => setHomeAxis(event.target.value as "X" | "Y" | "Z" | "ALL")}
            >
              <option value="ALL">All configured axes</option>
              <option value="X">X only</option>
              <option value="Y">Y only</option>
              <option value="Z">Z only</option>
            </select>
          </label>
          <label className="checkbox-row safety-confirmation">
            <input
              type="checkbox"
              checked={homeConfirmed}
              onChange={(event) => setHomeConfirmed(event.target.checked)}
            />
            Limit inputs, direction, clearance, and an emergency stop are ready.
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null || !homeConfirmed}
            onClick={() =>
              void runAction("home", {
                action: "home",
                confirmed: true,
                axis: homeAxis,
              })
            }
          >
            Start confirmed homing
          </button>
        </section>

        <section className="setup-card motion-card">
          <p className="eyebrow">PEN ACTUATOR</p>
          <h3>Test absolute Z lift</h3>
          <p>The cycle always finishes at the configured pen-up Z value.</p>
          <div className="field-row three">
            <label>
              Pen up Z
              <input
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
              <input
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
              <input
                aria-label="Test pen feed"
                type="number"
                min="1"
                max="1500"
                value={penFeed}
                onChange={(event) => setPenFeed(Number(event.target.value))}
              />
            </label>
          </div>
          <label className="checkbox-row safety-confirmation">
            <input
              type="checkbox"
              checked={penConfirmed}
              onChange={(event) => setPenConfirmed(event.target.checked)}
            />
            Z is homed or otherwise safe for these absolute positions.
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null || !penConfirmed || penUp === penDown}
            onClick={() =>
              void runAction("pen_test", {
                action: "pen_test",
                confirmed: true,
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
                setCommissioningTestConfirmed(false);
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
              <input
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
              <input
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
              <input
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
              <input
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
              <input
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
              <input
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
              <input
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
              <input
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
              <input
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
              <input
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
                <input
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
                <input
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
                <input
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
                <input
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
              <input
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
          <label className="checkbox-row safety-confirmation">
            <input
              type="checkbox"
              checked={commissioningTestConfirmed}
              onChange={(event) => setCommissioningTestConfirmed(event.target.checked)}
            />
            I have cleared this test area, verified the origin and Z values, and can stop the
            machine.
          </label>
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null || !commissioningTestConfirmed}
            onClick={() =>
              void runAction("commissioning-test", {
                action: "commissioning_test",
                confirmed: true,
                test: { ...commissioningTest, confirmed: true },
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
              <input
                aria-label="Current steps per millimetre"
                type="number"
                min="0.001"
                value={currentSteps}
                onChange={(event) => setCurrentSteps(Number(event.target.value))}
              />
            </label>
            <label>
              Commanded mm
              <input
                aria-label="Commanded calibration distance"
                type="number"
                min="0.001"
                value={commandedDistance}
                onChange={(event) => setCommandedDistance(Number(event.target.value))}
              />
            </label>
            <label>
              Measured mm
              <input
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
