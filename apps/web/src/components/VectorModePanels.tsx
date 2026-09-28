import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, FileCode2, MapPin, Plus, Search, Trash2 } from 'lucide-react';
import { MAP_ANNOTATION_FONT_OPTIONS, VECTOR_ALGORITHMS, algorithmDefaults } from '@plotter/algorithms';
import { makeId, type MapAnnotation, type PlotLayer, type ProjectState } from '@plotter/core';
import { api } from '../api';
import { glyphSvgToPaths, importedMapToLayers, parseSvgLayers, type MapSearchResult } from '../vectorSources';
import { loadGlyphLibrary } from './Glyphbox';
import { MapRegionPicker, type MapBounds, type MapView } from './MapRegionPicker';

type UpdateState = (update: Partial<ProjectState> | ((state: ProjectState) => ProjectState)) => void;

export function SvgSourcePanel({ state, updateState }: { state: ProjectState; updateState: UpdateState }) {
  const [error, setError] = useState('');
  const importFile = async (file?: File) => {
    if (!file) return;
    setError('');
    try {
      const layers = parseSvgLayers(await file.text(), state.canvas, state.passes.map((pass) => pass.id));
      updateState({ layers, sourceName: file.name, sourceAttribution: undefined, algorithmId: 'vector.layers' });
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  };
  return <div className="stack">
    <label className="file-drop"><FileCode2 /><span><strong>{state.sourceName ? 'Replace SVG' : 'Import SVG'}</strong><small>Paths, groups and primitive shapes</small></span><input type="file" accept="image/svg+xml,.svg" onChange={(event) => void importFile(event.target.files?.[0])} /></label>
    {state.sourceName && <div className="source-summary"><strong>{state.sourceName}</strong><span>{state.layers.length} layer{state.layers.length === 1 ? '' : 's'} · {state.layers.reduce((total, layer) => total + (layer.sourcePaths?.length ?? 0), 0)} source paths</span></div>}
    {error && <div className="notice error">{error}</div>}
    <p className="panel-copy">Top-level named groups become layers. Nested transforms are flattened and every supported SVG shape is converted to millimetre geometry.</p>
  </div>;
}

export function MapSourcePanel({ state, updateState }: { state: ProjectState; updateState: UpdateState }) {
  const [results, setResults] = useState<MapSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState('');
  const dataSource = state.mapSettings.dataSource ?? (state.mapSettings.includeTopography ? 'both' : 'openstreetmap');
  const view: MapView = { latitude: state.mapSettings.latitude ?? 54.5973, longitude: state.mapSettings.longitude ?? -5.9301, zoom: state.mapSettings.zoom ?? 14 };
  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    if (state.mapSettings.query.trim().length < 2) return;
    setSearching(true); setError('');
    try { setResults(await api.searchMaps(state.mapSettings.query.trim())); } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setSearching(false); }
  };
  const selectResult = (result: MapSearchResult) => {
    updateState({ mapSettings: { ...state.mapSettings, latitude: result.latitude, longitude: result.longitude, zoom: 15 } });
    setResults([]);
  };
  const downloadRegion = async (bounds: MapBounds) => {
    setDownloading(true); setError('');
    // Locking a new area intentionally discards the previous map before the request starts.
    updateState({ layers: [], sourceName: undefined, sourceAttribution: undefined, mapSettings: { ...state.mapSettings, bounds: undefined }, geometry: { paths: [], generatedAt: new Date().toISOString(), generator: 'none' } });
    try {
      const map = await api.importMap({ ...bounds, name: state.mapSettings.query.trim() || 'Selected map region', dataSource, contourInterval: state.mapSettings.contourInterval });
      const layers = importedMapToLayers(map, state.canvas, state.passes.map((pass) => pass.id));
      if (!layers.length) throw new Error('No supported map features were found in this area. Zoom out or move the selection.');
      updateState({ layers, sourceName: map.name, sourceAttribution: map.attribution, mapSettings: { ...state.mapSettings, bounds }, algorithmId: 'vector.layers' });
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setDownloading(false); }
  };
  return <div className="stack">
    <form className="map-search" onSubmit={(event) => void search(event)}><label>Place or address<input value={state.mapSettings.query} placeholder="e.g. Belfast City Hall" onChange={(event) => updateState({ mapSettings: { ...state.mapSettings, query: event.target.value } })} /></label><button className="button primary" disabled={searching}><Search size={15} /> {searching ? 'Searching…' : 'Search'}</button></form>
    {results.length > 0 && <div className="map-results">{results.map((result) => <button type="button" key={result.id} onClick={() => selectResult(result)}><MapPin /><span><strong>{result.displayName}</strong><small>{result.type} · show on map</small></span></button>)}</div>}
    <div className={`map-data-options ${dataSource === 'openstreetmap' ? 'osm-only' : ''}`}><label>Download<select value={dataSource} onChange={(event) => { const next = event.target.value as typeof dataSource; updateState({ mapSettings: { ...state.mapSettings, dataSource: next, includeTopography: next !== 'openstreetmap' } }); }}><option value="both">OSM + terrain</option><option value="terrain">Terrain only</option><option value="openstreetmap">OpenStreetMap only</option></select></label>{dataSource !== 'openstreetmap' && <label>Contour interval<select value={state.mapSettings.contourInterval ?? 10} onChange={(event) => updateState({ mapSettings: { ...state.mapSettings, contourInterval: Number(event.target.value) } })}><option value={5}>5 m</option><option value={10}>10 m</option><option value={20}>20 m</option><option value={25}>25 m</option><option value={50}>50 m</option><option value={100}>100 m</option><option value={200}>200 m</option></select></label>}<small>{dataSource === 'terrain' ? 'Only plot-ready elevation contours will be downloaded.' : dataSource === 'openstreetmap' ? 'Only OSM vectors. Large areas automatically omit buildings and minor roads.' : 'OSM and contours together. Large areas automatically omit buildings and minor roads.'}</small></div>
    <MapRegionPicker view={view} aspect={Math.max(0.1, (state.canvas.widthMm - state.canvas.marginMm * 2) / Math.max(1, state.canvas.heightMm - state.canvas.marginMm * 2))} busy={downloading} hasImport={Boolean(state.sourceName)} onChange={(next) => updateState({ mapSettings: { ...state.mapSettings, ...next } })} onDownload={(bounds) => void downloadRegion(bounds)} />
    {state.sourceName && <div className="source-summary"><strong>{state.sourceName}</strong><span>{state.layers.reduce((total, layer) => total + (layer.sourcePaths?.length ?? 0), 0).toLocaleString()} map features in {state.layers.length} layers</span></div>}
    {error && <div className="notice error">{error}</div>}
    <p className="attribution">{state.sourceAttribution ?? 'Map data © OpenStreetMap contributors · ODbL'}</p>
  </div>;
}

export function MapTitlePanel({ state, updateState }: { state: ProjectState; updateState: UpdateState }) {
  const title = state.mapTitle ?? { enabled: false, text: '', position: 'top' as const, font: MAP_ANNOTATION_FONT_OPTIONS[0].id, titleSizeMm: 8, showCoordinates: false, subtitleSizeMm: 3, passId: state.passes[0]?.id ?? '' };
  const updateTitle = (update: Partial<typeof title>) => updateState({ mapTitle: { ...title, ...update } });
  return <div className="stack">
    <label className="check-field"><input type="checkbox" checked={title.enabled} onChange={(event) => updateTitle({ enabled: event.target.checked })} /> Show map title</label>
    {title.enabled && <>
      <label>Title<input value={title.text} placeholder="e.g. Chamonix" onChange={(event) => updateTitle({ text: event.target.value })} /></label>
      <div className="field-row compact"><label>Position<select value={title.position} onChange={(event) => updateTitle({ position: event.target.value as 'top' | 'bottom' })}><option value="top">Top</option><option value="bottom">Bottom</option></select></label><label>Font<select value={title.font} onChange={(event) => updateTitle({ font: event.target.value })}>{MAP_ANNOTATION_FONT_OPTIONS.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label></div>
      <LayerRange label="Title size" value={title.titleSizeMm} min={3} max={20} step={0.5} unit="mm" onChange={(value) => updateTitle({ titleSizeMm: value })} />
      <label className="check-field"><input type="checkbox" checked={title.showCoordinates} onChange={(event) => updateTitle({ showCoordinates: event.target.checked })} /> Add map coordinates</label>
      {title.showCoordinates && <><LayerRange label="Coordinate size" value={title.subtitleSizeMm} min={1.5} max={10} step={0.5} unit="mm" onChange={(value) => updateTitle({ subtitleSizeMm: value })} />{!state.mapSettings.bounds && <small>Coordinates will appear after a map region is downloaded.</small>}</>}
      <label>Pen pass<select value={title.passId} onChange={(event) => updateTitle({ passId: event.target.value })}>{state.passes.map((pass) => <option value={pass.id} key={pass.id}>{pass.name} · {state.pens.find((pen) => pen.id === pass.penId)?.name}</option>)}</select></label>
      <small>Map detail is cleared behind the title block so the plotted text remains legible.</small>
    </>}
  </div>;
}

export function MapAnnotationPanel({ state, updateState }: { state: ProjectState; updateState: UpdateState }) {
  const annotations = state.mapAnnotations ?? [];
  const [glyphError, setGlyphError] = useState('');
  const mapGlyphs = useMemo(() => loadGlyphLibrary().assets.filter((asset) => asset.kind === 'map'), []);
  const defaultGlyph = mapGlyphs.find((asset) => asset.id === 'starter-map-pin') ?? mapGlyphs[0];
  const updateAnnotation = (id: string, update: Partial<MapAnnotation>) => updateState({ mapAnnotations: annotations.map((annotation) => annotation.id === id ? { ...annotation, ...update } : annotation) });
  const glyphUpdate = (glyphId: string): Partial<MapAnnotation> | undefined => {
    const glyph = mapGlyphs.find((asset) => asset.id === glyphId);
    if (!glyph) return undefined;
    try {
      const glyphPaths = glyphSvgToPaths(glyph.svg);
      if (!glyphPaths.length) throw new Error(`${glyph.name} does not contain supported plot paths.`);
      setGlyphError('');
      return { markerType: 'glyphbox', glyphId: glyph.id, glyphName: glyph.name, glyphPaths };
    } catch (value) {
      setGlyphError(value instanceof Error ? value.message : String(value));
      return undefined;
    }
  };
  const addAnnotation = () => {
    if (!defaultGlyph) return;
    const glyph = glyphUpdate(defaultGlyph.id);
    if (!glyph) return;
    updateState({ mapAnnotations: [...annotations, {
    id: makeId('annotation'),
    ...glyph,
    markerType: glyph.markerType ?? 'glyphbox',
    label: 'New location',
    xPercent: 50,
    yPercent: 50,
    markerSizeMm: 10,
    labelSizeMm: 4,
    font: MAP_ANNOTATION_FONT_OPTIONS[0].id,
    background: false,
    backgroundPaddingMm: 1.5,
    backgroundRadiusMm: 2,
    passId: state.passes[0]?.id ?? '',
    visible: true,
  }] });
  };
  return <div className="map-annotations">
    <p className="panel-copy">Positions are measured across the safe area, so markers stay aligned when the paper size changes.</p>
    <button className="button primary full" type="button" disabled={!defaultGlyph} onClick={addAnnotation}><Plus size={15} /> Add marker</button>
    {!mapGlyphs.length && <div className="notice error">Add a map glyph to Glyphbox from the main menu before creating an annotation.</div>}
    {glyphError && <div className="notice error">{glyphError}</div>}
    {annotations.map((annotation, index) => <details className="annotation-card" key={annotation.id} open={index === annotations.length - 1}>
      <summary><label className="check-field" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={annotation.visible} onChange={(event) => updateAnnotation(annotation.id, { visible: event.target.checked })} /><MapPin /><span><strong>{annotation.label || 'Unlabelled marker'}</strong><small>{annotation.xPercent}% across · {annotation.yPercent}% down</small></span></label><button className="icon-button small" type="button" title="Remove annotation" onClick={(event) => { event.preventDefault(); updateState({ mapAnnotations: annotations.filter((item) => item.id !== annotation.id) }); }}><Trash2 /></button></summary>
      <div className="annotation-settings">
        <label>Label<input value={annotation.label} placeholder="Location name" onChange={(event) => updateAnnotation(annotation.id, { label: event.target.value })} /></label>
        <label>Marker<select value={annotation.glyphId ?? ''} onChange={(event) => { const glyph = glyphUpdate(event.target.value); if (glyph) updateAnnotation(annotation.id, glyph); }}>{annotation.glyphId && !mapGlyphs.some((glyph) => glyph.id === annotation.glyphId) && <option value={annotation.glyphId}>{annotation.glyphName ?? 'Saved Glyphbox marker'} (saved)</option>}{mapGlyphs.map((glyph) => <option value={glyph.id} key={glyph.id}>{glyph.name}</option>)}</select></label>
        <div className="field-row compact"><label>X position (%)<input type="number" min="0" max="100" step="1" value={annotation.xPercent} onChange={(event) => updateAnnotation(annotation.id, { xPercent: Number(event.target.value) })} /></label><label>Y position (%)<input type="number" min="0" max="100" step="1" value={annotation.yPercent} onChange={(event) => updateAnnotation(annotation.id, { yPercent: Number(event.target.value) })} /></label></div>
        <LayerRange label="Marker size" value={annotation.markerSizeMm} min={2} max={30} step={0.5} unit="mm" onChange={(value) => updateAnnotation(annotation.id, { markerSizeMm: value })} />
        <LayerRange label="Label size" value={annotation.labelSizeMm} min={1.5} max={15} step={0.5} unit="mm" onChange={(value) => updateAnnotation(annotation.id, { labelSizeMm: value })} />
        <label>Font<select value={annotation.font} onChange={(event) => updateAnnotation(annotation.id, { font: event.target.value })}>{MAP_ANNOTATION_FONT_OPTIONS.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select></label>
        <label className="check-field"><input type="checkbox" checked={annotation.background ?? false} onChange={(event) => updateAnnotation(annotation.id, { background: event.target.checked })} /> Rounded paper background</label>
        {annotation.background && <><LayerRange label="Background padding" value={annotation.backgroundPaddingMm ?? 1.5} min={0.5} max={8} step={0.5} unit="mm" onChange={(value) => updateAnnotation(annotation.id, { backgroundPaddingMm: value })} /><LayerRange label="Corner radius" value={annotation.backgroundRadiusMm ?? 2} min={0} max={10} step={0.5} unit="mm" onChange={(value) => updateAnnotation(annotation.id, { backgroundRadiusMm: value })} /><small>The map is cleared beneath the box; its outline uses the annotation pen.</small></>}
        <label>Pen pass<select value={annotation.passId} onChange={(event) => updateAnnotation(annotation.id, { passId: event.target.value })}>{state.passes.map((pass) => <option value={pass.id} key={pass.id}>{pass.name} · {state.pens.find((pen) => pen.id === pass.penId)?.name}</option>)}</select></label>
      </div>
    </details>)}
    {!annotations.length && <p className="empty-annotation">No markers yet.</p>}
  </div>;
}

export function VectorLayerEditor({ state, updateState }: { state: ProjectState; updateState: UpdateState }) {
  const updateLayer = (id: string, update: Partial<PlotLayer>) => updateState({ layers: state.layers.map((layer) => layer.id === id ? { ...layer, ...update } : layer) });
  const moveLayer = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= state.layers.length) return;
    const layers = [...state.layers];
    [layers[index], layers[target]] = [layers[target]!, layers[index]!];
    updateState({ layers });
  };
  if (!state.layers.some((layer) => layer.sourcePaths?.length)) return <p className="panel-copy">Import a source to create editable layers.</p>;
  return <div className="vector-layers">
    <div className="layer-bulk"><button onClick={() => updateState({ layers: state.layers.map((layer) => ({ ...layer, visible: true })) })}>Show all</button><button onClick={() => updateState({ layers: state.layers.map((layer) => ({ ...layer, visible: false })) })}>Hide all</button></div>
    {state.layers.map((layer, index) => {
      const definition = VECTOR_ALGORITHMS.find((algorithm) => algorithm.id === layer.algorithmId) ?? VECTOR_ALGORITHMS[0]!;
      const settings = { ...algorithmDefaults(definition.id), ...layer.algorithmSettings };
      return <details className="vector-layer-card" key={layer.id} open={index < 3}>
        <summary><label className="check-field" onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={layer.visible} onChange={(event) => updateLayer(layer.id, { visible: event.target.checked })} /><span><strong>{layer.name}</strong><small>{layer.sourcePaths?.length ?? 0} paths · {layer.sourceCategory ?? 'SVG'}</small></span></label><span className="layer-tools"><button title="Move up" disabled={index === 0} onClick={(event) => { event.preventDefault(); moveLayer(index, -1); }}><ChevronUp /></button><button title="Move down" disabled={index === state.layers.length - 1} onClick={(event) => { event.preventDefault(); moveLayer(index, 1); }}><ChevronDown /></button><button title="Remove layer" onClick={(event) => { event.preventDefault(); updateState({ layers: state.layers.filter((item) => item.id !== layer.id) }); }}><Trash2 /></button></span></summary>
        <div className="vector-layer-settings">
          <label>Treatment<select value={definition.id} onChange={(event) => updateLayer(layer.id, { algorithmId: event.target.value, algorithmSettings: algorithmDefaults(event.target.value) })}>{VECTOR_ALGORITHMS.map((algorithm) => <option value={algorithm.id} key={algorithm.id}>{algorithm.name}</option>)}</select></label>
          {definition.controls.map((control) => control.type === 'number' ? <label key={control.key}>{control.label}<input type="number" min={control.min} max={control.max} step={control.step} value={Number(settings[control.key])} onChange={(event) => updateLayer(layer.id, { algorithmSettings: { ...settings, [control.key]: Number(event.target.value) } })} /></label> : control.type === 'select' ? <label key={control.key}>{control.label}<select value={String(settings[control.key])} onChange={(event) => updateLayer(layer.id, { algorithmSettings: { ...settings, [control.key]: event.target.value } })}>{control.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label> : <LayerRange key={control.key} label={control.label} value={Number(settings[control.key])} min={control.min ?? 0} max={control.max ?? 100} step={control.step ?? 1} unit={control.unit} onChange={(value) => updateLayer(layer.id, { algorithmSettings: { ...settings, [control.key]: value } })} />)}
          <label>Tool pass<select value={layer.passId} onChange={(event) => updateLayer(layer.id, { passId: event.target.value })}>{state.passes.map((pass) => <option value={pass.id} key={pass.id}>{pass.name} · {state.pens.find((pen) => pen.id === pass.penId)?.name}</option>)}</select></label>
          {definition.id === 'vector.crosshatch' && <label>Second hatch pass<select value={layer.secondaryPassId ?? layer.passId} onChange={(event) => updateLayer(layer.id, { secondaryPassId: event.target.value })}>{state.passes.map((pass) => <option value={pass.id} key={pass.id}>{pass.name} · {state.pens.find((pen) => pen.id === pass.penId)?.name}</option>)}</select></label>}
        </div>
      </details>;
    })}
  </div>;
}

function LayerRange({ label, value, min, max, step, unit = '', onChange }: { label: string; value: number; min: number; max: number; step: number; unit?: string; onChange: (value: number) => void }) {
  return <label className="range-field"><span><span>{label}</span><output>{value}{unit}</output></span><input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
