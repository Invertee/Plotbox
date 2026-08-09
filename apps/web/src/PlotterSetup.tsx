import { useEffect, useMemo, useState } from "react";

import { api } from "./api";
import type {
  AxisCalibrationResult,
  FluidNCActionRequest,
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
    } catch (reason) {
      setError(messageFor(reason));
    } finally {
      setBusy(null);
    }
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
          disabled={busy !== null}
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
            <h3>{result.action.replace("_", " ")}</h3>
          </div>
          {result.controller_state && <span className="state-pill">{result.controller_state}</span>}
          <code>{result.command_summary.join(" · ")}</code>
          <pre>{result.response_lines.join("\n") || "Command sent; no text response."}</pre>
        </section>
      )}
    </section>
  );
}
