import { useEffect, useState } from 'react';
import { DEFAULT_ISOMETRIC, isometricLayers, type IsometricGlyph, type IsometricSettings, type ProjectState } from '@plotter/core';
import { ISOMETRIC_ALGORITHMS } from '@plotter/algorithms';
import { glyphSvgToPaths } from '../vectorSources';
import { GlyphboxDialog, LEGACY_ISOMETRIC_STARTER_IDS, loadGlyphLibrary } from './Glyphbox';
import { glyphColours, prepareGlyphColourPasses } from './isometricColourPasses';
import { CITYSCAPE_CATEGORY, CITYSCAPE_PALETTE } from './isometricStarterGlyphs';

export function IsometricPanel({ state, updateState, onRedraw }: { state: ProjectState; updateState: (update: Partial<ProjectState>) => void; onRedraw: () => void }) {
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [error, setError] = useState('');
  const s = { ...DEFAULT_ISOMETRIC, ...state.isometric };
  const update = (value: Partial<IsometricSettings>) => updateState({ isometric: { ...s, ...value }, algorithmId: `isometric.${value.algorithm ?? s.algorithm}` });
  const refresh = () => {
    try {
      const library = loadGlyphLibrary();
      const glyphs: IsometricGlyph[] = library.assets.filter(g => g.kind === 'isometric').map(g => ({
        id: g.id, name: g.name, categoryId: g.categoryId, categoryName: library.categories.find(c => c.id === g.categoryId)?.name,
        role: g.isometricRole ?? 'building', terrain: g.terrain, shoreMask: g.shoreMask, treeLined: g.treeLined, paths: g.plotPaths ?? glyphSvgToPaths(g.svg, !!g.isometricRole && g.isometricRole !== 'building'),
      }));
      const { colourPasses, ...palette } = prepareGlyphColourPasses(glyphs, state.passes, state.pens, s.colourPasses);
      const migrateSelection = (ids: string[]) => [...new Set(ids.map(id => ['iso-architecture', 'iso-tall-buildings', 'iso-shopfronts', 'iso-roads', 'iso-roads-signs', 'iso-roads-signals'].includes(id) && !glyphs.some(g => g.categoryId === id) ? CITYSCAPE_CATEGORY : id))];
      updateState({
        isometricGlyphs: glyphs,
        ...palette,
        isometric: { ...s, colourPasses, buildingCategories: migrateSelection(s.buildingCategories), roadCategories: migrateSelection(s.roadCategories) },
        layers: [...state.layers, ...isometricLayers().filter(layer => !state.layers.some(existing => existing.id === layer.id))],
      });
      setError('');
    } catch (e) { setError(`Could not load isometric glyphs: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const hasLegacyGlyphs = state.isometricGlyphs?.some(glyph => LEGACY_ISOMETRIC_STARTER_IDS.has(glyph.id)) ?? false;
  // Existing drawings keep their saved artwork until the user reloads the library.
  useEffect(() => {
    if (!state.isometricGlyphs?.length && state.geometry.generator === 'none') refresh();
    else {
      const missing = isometricLayers().filter(layer => !state.layers.some(existing => existing.id === layer.id));
      if (missing.length) updateState({ layers: [...state.layers, ...missing] });
    }
  }, [state.isometricGlyphs]);
  const glyphs = state.isometricGlyphs ?? [];
  const colours = glyphColours(glyphs);
  const categories = [...new Map(glyphs.map(g => [g.categoryId ?? '', g.categoryName ?? 'Uncategorised'])).entries()];
  const number = (key: keyof IsometricSettings, label: string, min: number, max: number, step = 1) => <label>{label}<input type="number" min={min} max={max} step={step} value={Number(s[key])} onChange={e => update({ [key]: Math.max(min, Math.min(max, Number(e.target.value))) })} /></label>;
  const groups = (key: 'buildingCategories' | 'roadCategories', role: 'building' | 'road') => <fieldset className="iso-categories"><legend>{role === 'building' ? 'City & park districts' : 'Road collection'}</legend>
    <p className="panel-copy">{role === 'building' ? 'No selection uses all buildings, with green spaces mixed into each block. Select only Parks & green spaces for a park-only layout.' : 'No selection uses all road groups. Tree-lined avenues add the leafy collection along selected streets.'}</p>
    {categories.filter(([id]) => glyphs.some(g => (g.categoryId ?? '') === id && (role === 'building' ? g.role === 'building' || g.terrain === 'park' : g.role.startsWith('road-')))).map(([id, name]) => <label className="check-field" key={id}><input type="checkbox" checked={s[key].includes(id)} onChange={e => update({ [key]: e.target.checked ? [...s[key], id] : s[key].filter(value => value !== id) })} />{name}</label>)}
  </fieldset>;
  const pass = (key: 'buildingPassId' | 'roadPassId' | 'gridPassId', label: string) => <label>{label}<select value={state.passes.some(p => p.id === s[key]) ? s[key] : state.passes[0]?.id} onChange={e => update({ [key]: e.target.value })}>{state.passes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>;
  return <div className="stack">
    <p className="panel-copy">Lay out roads first, then grow building clusters along their frontage. Category groups form neighbourhoods.</p>
    <div className="field-row"><button className="button quiet" onClick={() => setLibraryOpen(true)}>Open Glyphbox</button><button className="button quiet" onClick={() => refresh()}>Reload glyphs</button></div>
    <p className="panel-copy">{glyphs.filter(g => g.role === 'building').length} buildings · {glyphs.filter(g => g.role.startsWith('road-')).length} roads · {glyphs.filter(g => g.role === 'terrain').length} landscape tiles. Reload to apply library changes.</p>
    {hasLegacyGlyphs && <div className="notice">The new Cityscape collection is available. Reload glyphs to replace the older city artwork in this drawing.</div>}
    {glyphs.some(g => g.categoryId === CITYSCAPE_CATEGORY) && <button className="button quiet full" onClick={() => update({ buildingCategories: [CITYSCAPE_CATEGORY], roadCategories: [CITYSCAPE_CATEGORY] })}>Use whole Cityscape collection</button>}
    {error && <div className="notice error">{error}</div>}
    {!glyphs.some(g => g.role === 'building') && <div className="notice">Add isometric buildings in Glyphbox, then reload glyphs.</div>}
    {s.algorithm === 'city' && <p className="panel-copy">Missing road shapes use connected centre lines. Restore the city set in Glyphbox for curbs and markings, or assign your SVGs road roles.</p>}
    {s.tiles && <div className="notice">Your layout contains {s.tiles.length} placed tiles. Edit tiles on the canvas to move, swap, add or remove them. Scene and district settings apply when you return to a generated layout.<button className="button quiet full" onClick={() => update({ tiles: undefined })}>Return to generated layout</button></div>}
    <fieldset className="iso-categories" disabled={!!s.tiles}><legend>Scene generator</legend>
    <label>Landscape<select value={s.landscape} onChange={e => update({ landscape: e.target.value as IsometricSettings['landscape'] })}><option value="city">City & parks</option><option value="coast">Coastal town</option><option value="lake">Lakeside city</option></select></label>
    {s.landscape !== 'city' && <>
      {number('waterCoverage', 'Water extent (%)', 20, 70, 5)}
      <label className="check-field"><input type="checkbox" checked={s.waterFeatures} onChange={e => update({ waterFeatures: e.target.checked })} /> Add boats & marine life</label>
      {!glyphs.some(g => g.terrain === 'water') && <div className="notice">Reload glyphs to add the Coasts & lakes collection.</div>}
    </>}
    <label>Placement algorithm<select value={s.algorithm} onChange={e => update({ algorithm: e.target.value as IsometricSettings['algorithm'] })}>{ISOMETRIC_ALGORITHMS.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></label>
    {s.algorithm === 'city' && <>
      <label>Green spaces per city block<select value={s.greenSpacesPerBlock} onChange={e => update({ greenSpacesPerBlock: Number(e.target.value) })}><option value={0}>None</option><option value={1}>One green space</option><option value={2}>Two green spaces</option></select></label>
      <label className="check-field"><input type="checkbox" checked={s.treeLinedStreets} onChange={e => update({ treeLinedStreets: e.target.checked })} /> Tree-lined avenues</label>
      <p className="panel-copy">Trees, lawns and pocket parks are mixed into building blocks. Tree-lined roads follow continuous avenues.</p>
    </>}
    </fieldset>
    <button className="button quiet full" onClick={onRedraw}>Redraw isometric plot</button>
    <label>Grid extent<select value={s.fit} onChange={e => update({ fit: e.target.value as IsometricSettings['fit'] })}><option value="square">Square ground grid · centred</option><option value="edges">Fill drawing to safe edges</option></select></label>
    {number('cells', s.fit === 'square' ? 'Cells per side' : 'Grid density', 4, 40)}
    <div className="field-row">{number('angle', 'Grid angle (°)', 15, 45)}{number('sourceAngle', 'Glyph original angle (°)', 15, 45)}</div>
    <p className="panel-copy">30° is standard isometric. Angle changes reshape the 2D SVGs; building heights scale with the artwork.</p>
    {number('buildingScale', 'Building footprint', 0.2, 1, 0.05)}
    {s.algorithm === 'city' && <>
      <label>Road plan<select value={s.roadLayout} onChange={e => update({ roadLayout: e.target.value as IsometricSettings['roadLayout'] })}><option value="blocks">Connected city blocks</option><option value="avenues">Long avenues</option></select></label>
      <div className="field-row">{number('blockSize', 'Block width (lots)', 2, 10)}{number('clusterDepth', 'Cluster depth (lots)', 1, 5)}</div>
      {number('density', 'Block occupancy (%)', 0, 100)}
      {number('districtSize', 'District size (blocks)', 1, 8)}
      {groups('roadCategories', 'road')}
    </>}
    {groups('buildingCategories', 'building')}
    {colours.length > 0 && <fieldset className="iso-categories"><legend>City colours</legend>
      <label className="check-field"><input type="checkbox" checked={s.useGlyphColours} onChange={e => update({ useGlyphColours: e.target.checked })} /> Use artwork colours</label>
      <label>Surface treatment<select value={s.fillMode} onChange={e => update({ fillMode: e.target.value as IsometricSettings['fillMode'] })}><option value="hatch">Hatched colour fills</option><option value="outline">Outlines only</option></select></label>
      {s.fillMode === 'hatch' && number('fillSpacing', 'Hatch spacing (mm)', 0.15, 5, 0.05)}
      <p className="panel-copy">Pale areas use the paper. Fills and lettering stay separated by pen colour. Use fewer grid cells or a larger sheet to give small signs and windows more room.</p>
      {s.useGlyphColours && colours.map(colour => <label className="iso-colour-assignment" key={colour}><span><i style={{ background: colour }} />{CITYSCAPE_PALETTE.find(c => c.colour === colour)?.name ?? colour}</span><select aria-label={`Pen for ${colour}`} value={state.passes.some(p => p.id === s.colourPasses[colour]) ? s.colourPasses[colour] : ''} onChange={e => update({ colourPasses: { ...s.colourPasses, [colour]: e.target.value } })}><option value="">Use building / road pen</option>{state.passes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>)}
      {s.useGlyphColours && <button className="button quiet full" onClick={() => { const { colourPasses, ...palette } = prepareGlyphColourPasses(glyphs, state.passes, state.pens, s.colourPasses); updateState({ ...palette, isometric: { ...s, colourPasses } }); }}>Restore colour passes</button>}
    </fieldset>}
    <label className="check-field"><input type="checkbox" checked={s.showGrid} onChange={e => update({ showGrid: e.target.checked })} /> Draw grid lines (included in export)</label>
    {pass('buildingPassId', 'Building pen pass')}
    {s.algorithm === 'city' && pass('roadPassId', 'Road pen pass')}
    {s.showGrid && pass('gridPassId', 'Grid pen pass')}
    <button className="button quiet full" onClick={() => update({ ...DEFAULT_ISOMETRIC, tiles: s.tiles, colourPasses: s.colourPasses })}>Reset isometric settings</button>
    {libraryOpen && <GlyphboxDialog initialKind="isometric" onClose={() => setLibraryOpen(false)} />}
  </div>;
}
