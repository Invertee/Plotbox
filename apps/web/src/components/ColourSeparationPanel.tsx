import type { ColourTreatment, ProjectState } from '@plotter/core';
import { colourPassId, DEFAULT_COLOUR_TREATMENT } from '@plotter/algorithms';

export function ColourSeparationPanel({ state, updateState, selected, setSelected }: { state: ProjectState; updateState: (update: Partial<ProjectState>) => void; selected: string; setSelected: (id: string) => void }) {
  const result = state.geometry.generator === 'raster.colour-separation' ? state.geometry.colourSeparation : undefined;
  if (!result) return <p className="panel-copy">Import an image to find its colours and separate pieces.</p>;
  const config = state.colourSeparation ?? { colours: {}, regions: {} };
  const region = result.regions.find(item => item.id === selected);
  const renamePass = (passId: string, name: string) => updateState({ passes: state.passes.map(pass => pass.id === passId ? { ...pass, name } : pass) });
  const treatmentFields = (value: ColourTreatment, change: (update: Partial<ColourTreatment>) => void, label: string) => {
    const selectedPass = state.passes.find(pass => pass.id === value.passId);
    return <div className="stack">
    <label className="check-field"><input type="checkbox" checked={value.enabled} onChange={e => change({ enabled: e.target.checked })} /> Plot {label}</label>
    <label>Pen pass<select value={value.passId} onChange={e => change({ passId: e.target.value })}>{state.passes.map(pass => <option key={pass.id} value={pass.id}>{pass.name}</option>)}</select></label>
    {selectedPass && <label>Pass name<input value={selectedPass.name} onChange={e => renamePass(selectedPass.id, e.target.value)} /></label>}
    <label>Fill treatment<select value={value.fill} onChange={e => change({ fill: e.target.value as ColourTreatment['fill'] })}><option value="hatch">Hatching</option><option value="crosshatch">Crosshatching</option><option value="solid">Dense fill (uses pen width)</option><option value="outline">Outline only</option><option value="none">No fill</option></select></label>
    {(value.fill === 'hatch' || value.fill === 'crosshatch') && <label>Spacing (mm)<input type="number" min={0.1} max={20} step={0.1} value={value.spacing} onChange={e => change({ spacing: Math.max(0.1, Number(e.target.value)) })} /></label>}
    {['hatch', 'crosshatch', 'solid'].includes(value.fill) && <label>Angle (°)<input type="number" min={0} max={180} value={value.angle} onChange={e => change({ angle: Number(e.target.value) })} /></label>}
    {value.fill !== 'outline' && <label className="check-field"><input type="checkbox" checked={value.outline} onChange={e => change({ outline: e.target.checked })} /> Add outline</label>}
    </div>;
  };
  return <div className="stack">
    <p className="panel-copy">{result.palette.length} colours · {result.regions.length} pieces. Each colour has its own pen pass. Set the real pen colour and thickness below. These are connected colour shapes, not recognised objects.</p>
    {result.palette.map(colour => {
      const pieces = result.regions.filter(r => r.colourId === colour.id);
      const value = { ...DEFAULT_COLOUR_TREATMENT, passId: colourPassId(colour.id), ...config.colours[colour.id] };
      const passName = state.passes.find(pass => pass.id === value.passId)?.name ?? `Colour ${Number(colour.id) + 1}`;
      return <details className="pass-card" key={colour.id}><summary><span style={{ display: 'inline-block', width: 14, height: 14, background: colour.colour, border: '1px solid #888', marginRight: 8 }} />{passName} · {pieces.length} pieces</summary>
        <small>Detected {colour.colour} · {colour.pixels.toLocaleString()} pixels</small>
        {treatmentFields(value, patch => updateState({ colourSeparation: { ...config, colours: { ...config.colours, [colour.id]: { ...config.colours[colour.id], ...patch } } } }), 'this colour')}
      </details>;
    })}
    <label>Individual piece<select value={region?.id ?? ''} onChange={e => setSelected(e.target.value)}><option value="">Choose a piece to override…</option>{[...result.regions].sort((a, b) => b.pixels - a.pixels).map((r) => {
      const passId = config.regions[r.id]?.passId ?? config.colours[r.colourId]?.passId ?? colourPassId(r.colourId);
      const passName = state.passes.find(pass => pass.id === passId)?.name ?? `Colour ${Number(r.colourId) + 1}`;
      return <option key={r.id} value={r.id}>{passName} · {r.pixels} px · x {Math.round(r.x * 100)}%, y {Math.round(r.y * 100)}%</option>;
    })}</select></label>
    {region && <div className="pass-card">
      <p className="panel-copy">Position is measured from the image’s top-left corner. Only changed settings override the colour defaults.</p>
      {treatmentFields({ ...DEFAULT_COLOUR_TREATMENT, passId: colourPassId(region.colourId), ...config.colours[region.colourId], ...config.regions[region.id] }, patch => updateState({ colourSeparation: { ...config, regions: { ...config.regions, [region.id]: { ...config.regions[region.id], ...patch } } } }), 'this piece')}
      <button className="button quiet full" onClick={() => { const regions = { ...config.regions }; delete regions[region.id]; updateState({ colourSeparation: { ...config, regions } }); }}>Use colour defaults</button>
    </div>}
    <p className="panel-copy">Changing separation settings or replacing the image resets treatments and automatic colour pens. Dense fill uses lines spaced at 85% of the pen width. Small pieces may need a thinner pen. Outlines follow the image pixel edges.</p>
  </div>;
}
