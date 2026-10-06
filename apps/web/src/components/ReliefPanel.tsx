import { DEFAULT_RELIEF, type ProjectState, type ReliefSettings } from '@plotter/core';

export function ReliefPanel({ state, updateState }: { state: ProjectState; updateState: (update: Partial<ProjectState>) => void }) {
  const settings = { ...DEFAULT_RELIEF, ...state.mapSettings.relief };
  const change = (update: Partial<ReliefSettings>) => updateState({ mapSettings: { ...state.mapSettings, relief: { ...settings, ...update } } });
  const ranges: Array<{ key: keyof ReliefSettings; label: string; min: number; max: number; step: number; unit: string }> = [
    { key: 'rotation', label: 'Rotation', min: 0, max: 360, step: 5, unit: '°' },
    { key: 'tilt', label: 'View elevation', min: 15, max: 75, step: 1, unit: '°' },
    { key: 'exaggeration', label: 'Vertical exaggeration', min: 0, max: 12, step: 0.25, unit: '×' },
    { key: 'contourInterval', label: 'Contour interval', min: 5, max: 200, step: 5, unit: 'm' },
    { key: 'spacing', label: 'Shading line spacing', min: 0.25, max: 3, step: 0.05, unit: 'mm' },
    { key: 'baseDepth', label: 'Base depth', min: 0, max: 10, step: 0.5, unit: 'mm' },
  ];
  return <div className="stack">
    <p className="panel-copy">Real terrain viewed in relief. Elevation colours fill the lower, middle and upper thirds of the selected height range. Hidden slopes are removed from every pass.</p>
    {ranges.map(({ key, label, min, max, step, unit }) => <label key={key}>{label} · {Number(settings[key]).toFixed(step < 1 ? 2 : 0)} {unit}<input type="range" min={min} max={max} step={step} value={Number(settings[key])} onChange={event => change({ [key]: Number(event.target.value) })} /></label>)}
    <label className="check-field"><input type="checkbox" checked={settings.clipBaseDepth} onChange={event => change({ clipBaseDepth: event.target.checked })} />Limit visible base depth</label>
    {settings.clipBaseDepth && <label>Maximum base depth · {settings.maxBaseDepth.toFixed(1)} mm<input type="range" min={1} max={50} step={0.5} value={settings.maxBaseDepth} onChange={event => change({ maxBaseDepth: Number(event.target.value) })} /></label>}
    {settings.clipBaseDepth && <small>Keeps only this much of the cut side below the terrain edge. The terrain surface is unchanged.</small>}
    {([['bands', 'Elevation colour fills'], ['shading', 'Slope shading'], ['water', 'Water outlines & fill']] as const).map(([key, label]) => <label className="check-field" key={key}><input type="checkbox" checked={settings[key]} onChange={event => change({ [key]: event.target.checked })} />{label}</label>)}
    {state.mapSettings.terrain && !state.mapSettings.terrain.water?.length && <small>No water features in this download. Choose OSM + terrain and download a region with mapped water to add them.</small>}
    {state.layers.map(layer => <div className="stack" key={layer.id}>
      <label className="check-field"><input type="checkbox" checked={layer.visible} onChange={event => updateState({ layers: state.layers.map(item => item.id === layer.id ? { ...item, visible: event.target.checked } : item) })} />{layer.name}</label>
      <label>Pen pass<select value={layer.passId} onChange={event => updateState({ layers: state.layers.map(item => item.id === layer.id ? { ...item, passId: event.target.value } : item) })}>{state.passes.map(pass => <option value={pass.id} key={pass.id}>{pass.name}</option>)}</select></label>
    </div>)}
    <small>Change ink colours and pen widths under Pens &amp; passes. Fills plot first, followed by shading, water and contours.</small>
  </div>;
}
