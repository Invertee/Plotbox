import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Cable, CircleStop, Home, Radio, RefreshCw, Save, Target, Unlock, X } from 'lucide-react';
import { fluidNCWebSocketCandidates, loadFluidNCSettings, normalizeFluidNCUrl, parseFluidNCStatus, saveFluidNCSettings, type FluidNCPosition, type FluidNCSettings, type FluidNCStatus } from '../fluidnc';

export function FluidNCSettingsDialog({ onClose }: { onClose: () => void }) {
  const saved = loadFluidNCSettings();
  const [name, setName] = useState(saved?.name ?? 'Workshop plotter');
  const [websocketUrl, setWebsocketUrl] = useState(saved?.websocketUrl ?? '');
  const [error, setError] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const normalized = normalizeFluidNCUrl(websocketUrl);
      if (!normalized) throw new Error('Enter the FluidNC address.');
      saveFluidNCSettings({ name: name.trim() || 'FluidNC', websocketUrl: normalized });
      window.dispatchEvent(new Event('fluidnc-settings-changed'));
      onClose();
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    }
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="modal fluidnc-settings" onSubmit={submit}>
      <div className="modal-head"><div><p className="eyebrow">GLOBAL SETTING</p><h2>FluidNC instance</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X /></button></div>
      <div className="machine-intro"><span><Cable /></span><div><strong>Connect your plotter</strong><p>This instance is available to every Plotbox project in this browser.</p></div></div>
      <label>Instance name<input value={name} autoFocus onChange={(event) => setName(event.target.value)} placeholder="Workshop plotter" /></label>
      <label>FluidNC address<input value={websocketUrl} onChange={(event) => setWebsocketUrl(event.target.value)} placeholder="192.168.1.50" required /><small>Enter the controller hostname or IP. Plotbox uses FluidNC's root WebSocket endpoint and will also try the legacy port 81 endpoint.</small></label>
      {error && <div className="notice error">{error}</div>}
      <div className="modal-actions"><button type="button" className="button quiet" onClick={onClose}>Cancel</button><button className="button primary"><Save size={16} /> Save instance</button></div>
    </form>
  </div>;
}

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';

export function FluidNCControlDialog({ onClose }: { onClose: () => void }) {
  const settings = loadFluidNCSettings();
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const reconnectRef = useRef(0);
  const [connection, setConnection] = useState<ConnectionState>(settings ? 'connecting' : 'disconnected');
  const [status, setStatus] = useState<FluidNCStatus>({ state: 'Unknown' });
  const [message, setMessage] = useState(settings ? 'Opening WebSocket…' : 'Add a FluidNC instance from the projects page first.');
  const [xyJogDistance, setXyJogDistance] = useState('1');
  const [zJogDistance, setZJogDistance] = useState('1');
  const [xyFeedRate, setXyFeedRate] = useState('1000');
  const [zFeedRate, setZFeedRate] = useState('600');

  const connect = () => {
    if (!settings) return;
    reconnectRef.current += 1;
    const connectionId = reconnectRef.current;
    socketRef.current?.close();
    setConnection('connecting');
    setMessage('Opening WebSocket…');
    const candidates = fluidNCWebSocketCandidates(settings.websocketUrl);
    const tryCandidate = (index: number) => {
      if (connectionId !== reconnectRef.current) return;
      const candidate = candidates[index];
      if (!candidate) {
        setConnection('error');
        setMessage('Could not reach FluidNC. Check its address and network.');
        return;
      }
      setMessage(`Opening ${candidate}…`);
      const socket = new WebSocket(candidate);
      // Some FluidNC builds send the regular Grbl status report as a binary
      // WebSocket frame.  Request an ArrayBuffer so it can be decoded just as
      // reliably as a text frame (the browser default Blob was being ignored).
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;
      socket.onopen = () => {
        if (connectionId !== reconnectRef.current) return;
        setConnection('connected');
        setMessage('Live status connected');
        socket.send('?');
      };
      socket.onmessage = async (event) => {
        const text = await fluidNCMessageText(event.data);
        if (!text) return;
        for (const line of text.split(/[\r\n]+/)) {
          const parsed = parseFluidNCStatus(line);
          if (parsed) setStatus((current) => ({ ...current, ...parsed }));
        }
      };
      socket.onerror = () => {
        if (connectionId !== reconnectRef.current) return;
        // onclose performs the fallback; browsers also fire error for the same failure.
      };
      socket.onclose = () => {
        if (connectionId !== reconnectRef.current) return;
        if (socketRef.current === socket && socket.readyState !== WebSocket.OPEN && index + 1 < candidates.length) {
          tryCandidate(index + 1);
          return;
        }
        setConnection('disconnected');
        setMessage('FluidNC disconnected');
      };
    };
    try {
      tryCandidate(0);
    } catch (value) {
      setConnection('error');
      setMessage(value instanceof Error ? value.message : String(value));
    }
  };

  useEffect(() => {
    connect();
    // FluidNC delivers each response over this WebSocket.  Ask for a fresh
    // realtime status ten times a second so the panel feels live during jogs.
    const poll = window.setInterval(() => {
      if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send('?');
    }, 100);
    return () => {
      reconnectRef.current += 1;
      window.clearInterval(poll);
      socketRef.current?.close();
    };
  // Connect only when the modal is opened; reconnects are user initiated.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = (command: string) => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setMessage('Connect to FluidNC before sending a command.');
      return;
    }
    socketRef.current.send(command);
  };

  const stop = () => {
    if (socketRef.current?.readyState !== WebSocket.OPEN) {
      setMessage('Connect to FluidNC before sending a command.');
      return;
    }
    socketRef.current.send('\x18');
    setMessage('Emergency stop sent');
  };

  const jog = (axis: 'X' | 'Y' | 'Z', direction: 1 | -1) => {
    const selectedDistance = axis === 'Z' ? zJogDistance : xyJogDistance;
    const distance = Number(selectedDistance) * direction;
    const feedRate = axis === 'Z' ? zFeedRate : xyFeedRate;
    send(`G91\nG0 ${axis}${distance} F${feedRate}\nG90\n`);
    setMessage(`Moving ${axis} ${direction > 0 ? '+' : '−'}${selectedDistance} mm`);
  };

  const clearAlarm = () => {
    send('$X\n');
    setMessage('Alarm clear requested');
  };

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal machine-control" role="dialog" aria-modal="true" aria-labelledby="machine-control-title">
      <div className="modal-head"><div><p className="eyebrow">PLOTTER CONTROL</p><h2 id="machine-control-title">{settings?.name ?? 'FluidNC'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X /></button></div>
      <div className={`connection-banner ${connection}`}><span className="connection-light" /><div><strong>{connection === 'connected' ? status.state : connection === 'connecting' ? 'Connecting' : 'Offline'}</strong><small>{message}</small></div>{settings && connection !== 'connected' && <button className="button quiet" onClick={connect}><RefreshCw size={14} /> Retry</button>}</div>
      <PositionPanel machine={status.machinePosition} work={status.workPosition} />
      <div className="control-section manual-motion"><div className="control-section-title"><span>Manual motion</span><small>Jog from the current work position</small></div><div className="jog-controls"><div className="jog-pad" aria-label="XY jog controls"><button className="jog-button up" aria-label="Move Y positive" disabled={connection !== 'connected'} onClick={() => jog('Y', 1)}><ArrowUp size={18} /><span>Y+</span></button><button className="jog-button left" aria-label="Move X negative" disabled={connection !== 'connected'} onClick={() => jog('X', -1)}><ArrowLeft size={18} /><span>X−</span></button><span className="jog-origin">XY</span><button className="jog-button right" aria-label="Move X positive" disabled={connection !== 'connected'} onClick={() => jog('X', 1)}><ArrowRight size={18} /><span>X+</span></button><button className="jog-button down" aria-label="Move Y negative" disabled={connection !== 'connected'} onClick={() => jog('Y', -1)}><ArrowDown size={18} /><span>Y−</span></button></div><div className="z-jog"><span>Z axis</span><button className="jog-button" aria-label="Move Z positive" disabled={connection !== 'connected'} onClick={() => jog('Z', 1)}><ArrowUp size={18} /><span>Z+</span></button><button className="jog-button" aria-label="Move Z negative" disabled={connection !== 'connected'} onClick={() => jog('Z', -1)}><ArrowDown size={18} /><span>Z−</span></button></div></div><div className="jog-settings"><label>XY step<select value={xyJogDistance} onChange={(event) => setXyJogDistance(event.target.value)}><option value="0.1">0.1 mm</option><option value="1">1 mm</option><option value="10">10 mm</option><option value="100">100 mm</option></select></label><label>Z step<select value={zJogDistance} onChange={(event) => setZJogDistance(event.target.value)}><option value="0.1">0.1 mm</option><option value="1">1 mm</option><option value="10">10 mm</option></select></label><label>XY speed<select value={xyFeedRate} onChange={(event) => setXyFeedRate(event.target.value)}><option value="300">300 mm/min</option><option value="1000">1000 mm/min</option><option value="3000">3000 mm/min</option></select></label><label>Z speed<select value={zFeedRate} onChange={(event) => setZFeedRate(event.target.value)}><option value="300">300 mm/min</option><option value="600">600 mm/min</option><option value="1000">1000 mm/min</option></select></label></div></div>
      <div className="control-section"><div className="control-section-title"><span>Homing</span><small>Move each axis to its machine origin</small></div><div className="axis-actions">{(['X', 'Y', 'Z'] as const).map((axis) => <button className="axis-button" key={axis} disabled={connection !== 'connected'} onClick={() => send(`$H${axis}\n`)}><Home size={16} /><strong>{axis}</strong><span>Home</span></button>)}</div></div>
      <div className="control-section"><div className="control-section-title"><span>Work coordinates</span><small>Set the current pen height as the work zero</small></div><div className="z-axis-actions"><button className="z-axis-button" disabled={connection !== 'connected'} onClick={() => { send('G92 Z0\n'); setMessage('Current height set as Z zero'); }}><Target size={16} /><strong>Set Z zero</strong></button></div></div>
      <div className="stop-panel"><div><strong>Emergency stop</strong><span>Immediately reset the controller and halt motion.</span></div><div className="stop-actions"><button className="clear-alarm-button" disabled={connection !== 'connected'} onClick={clearAlarm}><Unlock size={16} /> Clear alarm</button><button className="stop-button" disabled={connection !== 'connected'} onClick={stop}><CircleStop size={19} /> Stop</button></div></div>
      <div className="machine-footer"><Radio size={13} /><span>{settings?.websocketUrl ?? 'No FluidNC instance configured'}</span></div>
    </section>
  </div>;
}

async function fluidNCMessageText(data: unknown): Promise<string | undefined> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (data instanceof Blob) return data.text();
  return undefined;
}

function PositionPanel({ machine, work }: { machine?: FluidNCPosition; work?: FluidNCPosition }) {
  const selected = work ?? machine;
  return <div className="position-panel"><div className="position-heading"><div><span>Current position</span><small>{work ? 'Work coordinates' : 'Machine coordinates'}</small></div><span className="position-unit">mm</span></div><div className="position-grid">{(['x', 'y', 'z'] as const).map((axis) => <div key={axis}><span>{axis.toUpperCase()}</span><strong>{selected ? selected[axis].toFixed(3) : '—'}</strong></div>)}</div></div>;
}
