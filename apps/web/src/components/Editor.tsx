import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Cable, ChevronDown, ChevronUp, Download, FileImage, LocateFixed, Maximize2, Play, Plus, RefreshCw, Save, Terminal, Trash2, Upload, X, ZoomIn, ZoomOut } from 'lucide-react';
import { DEFAULT_PREPROCESS, DEFAULT_RASTER_PLACEMENT, DEFAULT_TURTLE_PLACEMENT, type PenProfile, type PlotGeometry, type PlotPass, type ProjectState } from '@plotter/core';
import { ALGORITHMS, algorithmDefaults, generateAlgorithm, generateVectorLayers, ensureColourPasses, ensureScribbleColourPasses } from '@plotter/algorithms';
import type { GCodeDocument } from '@plotter/gcode';
import { pathLength } from '@plotter/geometry';
import { api } from '../api';
import { useEditorStore } from '../store';
import { MapSourcePanel, SvgSourcePanel, VectorLayerEditor } from './VectorModePanels';
import { FluidNCControlDialog } from './FluidNC';
import { ColourSeparationPanel } from './ColourSeparationPanel';
import { loadFluidNCSettings, type FluidNCPosition } from '../fluidnc';

type RenderStatus = { active: boolean; value: number; message: string; error?: string };
type PreviewQuality = 'standard' | 'high' | 'ultra';

const PREVIEW_QUALITY: Record<PreviewQuality, { label: string; scale: number; maxPixels: number; maxDimension: number }> = {
  standard: { label: 'Standard', scale: 1, maxPixels: 12_000_000, maxDimension: 4_096 },
  high: { label: 'High', scale: 2, maxPixels: 24_000_000, maxDimension: 8_192 },
  ultra: { label: 'Ultra', scale: 4, maxPixels: 40_000_000, maxDimension: 12_000 },
};

async function imageDataFromUrl(url: string, maximum = 1000): Promise<ImageData> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const scale = Math.min(1, maximum / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas image processing is unavailable.');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export function Editor({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const { project, dirty, setProject, updateState, updateName, setGeometry, markSaved } = useEditorStore();
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [render, setRender] = useState<RenderStatus>({ active: false, value: 0, message: '' });
  const [gcodeOpen, setGcodeOpen] = useState(false);
  const [controlOpen, setControlOpen] = useState(false);
  const [paintCapture, setPaintCapture] = useState<{ penId: string; passName: string }>();
  const [selectedRegion, setSelectedRegion] = useState('');
  const [redrawNonce, setRedrawNonce] = useState(0);
  const renderJob = useRef(0);
  const workerRef = useRef<Worker | null>(null);
  const saveRevision = useRef(0);

  useEffect(() => {
    const { body, documentElement } = document;
    body.classList.add('editor-active');
    documentElement.classList.add('editor-active');
    return () => {
      body.classList.remove('editor-active');
      documentElement.classList.remove('editor-active');
    };
  }, []);

  useEffect(() => {
    setLoading(true);
    api.getProject(projectId).then((loaded) => {
      if (!Object.keys(loaded.state.algorithmSettings).length) loaded.state.algorithmSettings = algorithmDefaults(loaded.state.algorithmId);
      loaded.state.rasterPlacement = { ...DEFAULT_RASTER_PLACEMENT, ...loaded.state.rasterPlacement };
      loaded.state.turtlePlacement = { ...DEFAULT_TURTLE_PLACEMENT, ...loaded.state.turtlePlacement };
      loaded.state.pens = loaded.state.pens.map((pen) => ({ ...pen, mediaType: pen.mediaType ?? 'pen', zUpFeed: pen.zUpFeed ?? pen.zFeed ?? 600, zDownFeed: pen.zDownFeed ?? pen.zFeed ?? 600 }));
      const savedMapSettings = loaded.state.mapSettings as Partial<ProjectState['mapSettings']> | undefined;
      const dataSource = savedMapSettings?.dataSource ?? (savedMapSettings?.includeTopography ? 'both' : 'openstreetmap');
      loaded.state.mapSettings = { query: savedMapSettings?.query ?? '', radiusKm: savedMapSettings?.radiusKm ?? 1, dataSource, includeTopography: dataSource !== 'openstreetmap', contourInterval: savedMapSettings?.contourInterval ?? 10, latitude: savedMapSettings?.latitude, longitude: savedMapSettings?.longitude, zoom: savedMapSettings?.zoom ?? 14 };
      setProject(loaded);
    }).catch((error: Error) => setRender({ active: false, value: 0, message: '', error: error.message })).finally(() => setLoading(false));
    return () => setProject(undefined);
  }, [projectId, setProject]);

  useEffect(() => {
    const revision = ++saveRevision.current;
    if (!project || !dirty) return;
    setSaveState('saving');
    const timeout = window.setTimeout(() => {
      api.saveProject(project.id, project.name, project.state).then((saved) => {
        // A delayed response must not restore an earlier algorithm/settings snapshot.
        if (revision !== saveRevision.current) return;
        markSaved(saved);
        setSaveState('saved');
      }).catch(() => {
        if (revision === saveRevision.current) setSaveState('error');
      });
    }, 750);
    return () => window.clearTimeout(timeout);
  }, [project, dirty, markSaved]);

  const algorithmId = project?.state.algorithmId;
  const settingsKey = JSON.stringify(project?.state.algorithmSettings ?? {});
  const preprocessKey = JSON.stringify(project?.state.preprocess ?? {});
  const placementKey = JSON.stringify(project?.state.rasterPlacement ?? DEFAULT_RASTER_PLACEMENT);
  const turtlePlacementKey = JSON.stringify(project?.state.turtlePlacement ?? DEFAULT_TURTLE_PLACEMENT);
  const sourceImage = project?.state.sourceImage;
  const canvasKey = JSON.stringify(project?.state.canvas ?? {});
  const passIds = project?.state.passes.map((pass) => pass.id).join(',') ?? '';
  const layersKey = JSON.stringify(project?.state.layers ?? []);
  const colourKey = JSON.stringify(project?.state.colourSeparation ?? {});
  const colourPensKey = algorithmId === 'raster.colour-separation' ? JSON.stringify({ passes: project?.state.passes, pens: project?.state.pens.map(p => ({ id: p.id, widthMm: p.widthMm })) }) : '';
  const scribblePenKey = algorithmId === 'raster.continuous-scribble' || algorithmId === 'raster.paint-scribble' ? JSON.stringify({ pass: project?.state.passes[0]?.penId, pens: project?.state.pens.map(p => ({ id: p.id, widthMm: p.widthMm })) }) : '';
  const projectMode = project?.mode;
  const renderSignature = useMemo(() => JSON.stringify({ projectId, algorithmId, settingsKey, preprocessKey, placementKey, turtlePlacementKey, sourceImage, canvasKey, passIds, layersKey, projectMode, redrawNonce, colourKey, colourPensKey, scribblePenKey }), [projectId, algorithmId, settingsKey, preprocessKey, placementKey, turtlePlacementKey, sourceImage, canvasKey, passIds, layersKey, projectMode, redrawNonce, colourKey, colourPensKey, scribblePenKey]);
  const drawingLength = useMemo(() => project?.state.geometry.paths.reduce((total, item) => total + pathLength(item), 0) ?? 0, [project?.state.geometry]);
  const latestRenderSignature = useRef(renderSignature);

  // Update before paint so a worker that finishes between a state commit and effect
  // cleanup cannot replace the new preview with an older algorithm's geometry.
  useLayoutEffect(() => {
    latestRenderSignature.current = renderSignature;
  }, [renderSignature]);

  useEffect(() => {
    if (!project || !algorithmId) return;
    workerRef.current?.terminate();
    workerRef.current = null;
    const jobId = ++renderJob.current;
    const isCurrentRender = () => jobId === renderJob.current && latestRenderSignature.current === renderSignature;
    const timer = window.setTimeout(async () => {
      const state = project.state;
      if (project.mode === 'svg' || project.mode === 'map') {
        if (!state.layers.some((layer) => layer.sourcePaths?.length)) { setRender({ active: false, value: 0, message: project.mode === 'svg' ? 'Import an SVG to create layers.' : 'Search for a place and import map data.' }); return; }
        setRender({ active: true, value: 0.45, message: 'Applying layer treatments' });
        const result = generateVectorLayers(state.layers);
        if (isCurrentRender()) { setGeometry(result); setRender({ active: false, value: 1, message: `${result.paths.length.toLocaleString()} paths from ${state.layers.filter((layer) => layer.visible).length} layers` }); }
        return;
      }
      if (algorithmId.startsWith('raster.') && !state.sourceImage) { setRender({ active: false, value: 0, message: 'Import an image to render.' }); return; }
      if (algorithmId === 'generative.turtle' || algorithmId.startsWith('raster.')) {
        const worker = new Worker(new URL('../workers/render.worker.ts', import.meta.url), { type: 'module' });
        workerRef.current = worker;
        setRender({ active: true, value: 0.01, message: 'Preparing render' });
        worker.onmessage = (event: MessageEvent<{ type: string; jobId: number; value?: number; message?: string; result?: PlotGeometry }>) => {
          if (event.data.jobId !== renderJob.current || !isCurrentRender()) return;
          if (event.data.type === 'progress') setRender({ active: true, value: event.data.value ?? 0, message: event.data.message ?? 'Rendering' });
          if (event.data.type === 'complete' && event.data.result) { const result = event.data.result; if (algorithmId === 'raster.continuous-scribble') { updateState(current => ({ ...current, geometry: result, ...ensureScribbleColourPasses(result.colourSeparation?.palette ?? [], current.passes, current.pens) })); } else if (result.colourSeparation) { updateState(current => ({ ...current, geometry: result, ...ensureColourPasses(result.colourSeparation!.palette, current.passes, current.pens) })); } else setGeometry(result); setRender({ active: false, value: 1, message: `${event.data.result.paths.length.toLocaleString()} paths` }); worker.terminate(); if (workerRef.current === worker) workerRef.current = null; }
          if (event.data.type === 'error') { setRender({ active: false, value: 0, message: '', error: event.data.message }); worker.terminate(); if (workerRef.current === worker) workerRef.current = null; }
        };
        const imageData = state.sourceImage ? await imageDataFromUrl(state.sourceImage, algorithmId === 'raster.continuous-scribble' || algorithmId === 'raster.paint-scribble' ? 2400 : 1000) : undefined;
        if (!isCurrentRender()) { worker.terminate(); return; }
        worker.postMessage({ jobId, algorithmId, canvas: state.canvas, settings: state.algorithmSettings, preprocess: state.preprocess, rasterPlacement: state.rasterPlacement, turtlePlacement: state.turtlePlacement, passIds: state.passes.map((pass) => pass.id), colourSeparation: state.colourSeparation, passes: state.passes, pens: state.pens, imageData });
        return;
      }
      setRender({ active: true, value: 0.4, message: 'Generating geometry' });
      const result = generateAlgorithm(algorithmId, state.canvas, state.algorithmSettings, state.passes.map((pass) => pass.id));
      if (isCurrentRender()) { setGeometry(result); setRender({ active: false, value: 1, message: `${result.paths.length.toLocaleString()} paths` }); }
    }, 180);
    return () => { window.clearTimeout(timer); renderJob.current += 1; workerRef.current?.terminate(); workerRef.current = null; };
  // Serialized settings are intentional: state objects are immutable and regenerate only for render-affecting changes.
  }, [algorithmId, settingsKey, preprocessKey, placementKey, turtlePlacementKey, sourceImage, canvasKey, passIds, layersKey, projectMode, redrawNonce, renderSignature, colourKey, colourPensKey]);

  if (loading) return <div className="loading-screen"><RefreshCw className="spin" /> Loading plot…</div>;
  if (!project) return <div className="loading-screen"><p>{render.error ?? 'Project not found.'}</p><button className="button" onClick={onBack}>Back to projects</button></div>;
  const state = project.state;
  const algorithms = ALGORITHMS.filter((algorithm) => project.mode === 'raster' ? algorithm.group === 'raster' : algorithm.group !== 'raster');
  const definition = ALGORITHMS.find((item) => item.id === state.algorithmId);
  const updateAlgorithm = (nextId: string) => updateState({ algorithmId: nextId, algorithmSettings: algorithmDefaults(nextId), layers: state.layers.map((layer) => ({ ...layer, algorithmId: nextId })), ...(nextId === 'raster.continuous-scribble' ? {} : ensureScribbleColourPasses([], state.passes, state.pens)) });
  const resetColours = () => ({ colourSeparation: { colours: {}, regions: {} }, passes: state.passes.filter(p => !p.id.startsWith('colour-pass-')), pens: state.pens.filter(p => !p.id.startsWith('colour-pen-')) });
  const changeAlgorithmSettings = (algorithmSettings: ProjectState['algorithmSettings']) => updateState({ algorithmSettings, ...(state.algorithmId === 'raster.colour-separation' ? resetColours() : {}) });
  const importImage = (file?: File) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => updateState({ sourceImage: String(reader.result), ...resetColours() });
    reader.readAsDataURL(file);
  };
  return <div className="editor-shell">
    <header className="editor-header">
      <button className="icon-button" onClick={onBack} title="Back to projects"><ArrowLeft /></button>
      <div className="editor-title"><input value={project.name} onChange={(event) => updateName(event.target.value)} /><span>{project.mode} · {state.canvas.widthMm} × {state.canvas.heightMm} mm</span></div>
      <div className={`save-state ${saveState}`}><Save size={14} /> {saveState === 'saved' ? 'Saved locally' : saveState === 'saving' ? 'Saving…' : 'Save failed'}</div>
      <button className="button quiet" onClick={() => { setPaintCapture(undefined); setControlOpen(true); }}><Cable size={16} /> Control</button>
      <button className="button secondary" onClick={() => setGcodeOpen(true)}><Download size={16} /> Export G-code</button>
    </header>
    <aside className="left-panel scroll-panel">
      <Panel title="Source" open>
        {project.mode === 'raster' && <div className="stack">
          <label className="file-drop"><FileImage /><span><strong>{state.sourceImage ? 'Replace image' : 'Import raster image'}</strong><small>PNG, JPEG or WebP</small></span><input type="file" accept="image/*" onChange={(event) => importImage(event.target.files?.[0])} /></label>
          {state.sourceImage && <><img className="source-thumb" style={state.algorithmId === 'raster.colour-separation' ? { filter: 'none' } : undefined} src={state.sourceImage} alt="Imported source" /><div className="source-placement">
            <label>Fit inside safe area<select value={state.rasterPlacement.fit} onChange={(event) => updateState({ rasterPlacement: { ...state.rasterPlacement, fit: event.target.value as ProjectState['rasterPlacement']['fit'] } })}><option value="contain">Contain — show all</option><option value="cover">Cover — crop to fill</option><option value="stretch">Stretch — fill exactly</option></select></label>
            <RangeField label="Image scale" unit="%" value={state.rasterPlacement.scalePercent} min={10} max={300} step={5} onChange={(value) => updateState({ rasterPlacement: { ...state.rasterPlacement, scalePercent: value } })} />
            <div className="field-row compact"><label>Offset X (mm)<input type="number" step="1" value={state.rasterPlacement.offsetXmm} onChange={(event) => updateState({ rasterPlacement: { ...state.rasterPlacement, offsetXmm: Number(event.target.value) } })} /></label><label>Offset Y (mm)<input type="number" step="1" value={state.rasterPlacement.offsetYmm} onChange={(event) => updateState({ rasterPlacement: { ...state.rasterPlacement, offsetYmm: Number(event.target.value) } })} /></label></div>
            <button className="button quiet full" onClick={() => updateState({ rasterPlacement: { ...DEFAULT_RASTER_PLACEMENT } })}>Reset image placement</button>
          </div></>}
        </div>}
        {project.mode === 'generative' && <p className="panel-copy">Seeded generators create reproducible vector paths directly in paper coordinates.</p>}
        {project.mode === 'svg' && <SvgSourcePanel state={state} updateState={updateState} />}
        {project.mode === 'map' && <MapSourcePanel state={state} updateState={updateState} />}
      </Panel>
      {project.mode === 'raster' && state.algorithmId !== 'raster.colour-separation' && <Panel title="Image preprocessing">
        <RangeField label="Brightness" value={state.preprocess.brightness} min={-100} max={100} onChange={(value) => updateState({ preprocess: { ...state.preprocess, brightness: value } })} />
        <RangeField label="Contrast" value={state.preprocess.contrast} min={-100} max={100} onChange={(value) => updateState({ preprocess: { ...state.preprocess, contrast: value } })} />
        <RangeField label="Gamma" value={state.preprocess.gamma} min={0.2} max={3} step={0.1} onChange={(value) => updateState({ preprocess: { ...state.preprocess, gamma: value } })} />
        <RangeField label="Blur" value={state.preprocess.blur} min={0} max={5} step={1} onChange={(value) => updateState({ preprocess: { ...state.preprocess, blur: value } })} />
        <RangeField label="Tone threshold" value={state.preprocess.threshold} min={10} max={245} onChange={(value) => updateState({ preprocess: { ...state.preprocess, threshold: value } })} />
        <label className="check-field"><input type="checkbox" checked={state.preprocess.invert} onChange={(event) => updateState({ preprocess: { ...state.preprocess, invert: event.target.checked } })} /> Invert tones</label>
        <button className="button quiet full" onClick={() => updateState({ preprocess: { ...DEFAULT_PREPROCESS } })}><RefreshCw size={15} /> Reset preprocessing</button>
      </Panel>}
      {(project.mode === 'raster' || project.mode === 'generative') && <Panel title={project.mode === 'raster' ? 'Vectorisation' : 'Generator'} open>
        <label>Algorithm<select value={state.algorithmId} onChange={(event) => updateAlgorithm(event.target.value)}>{algorithms.map((algorithm) => <option value={algorithm.id} key={algorithm.id}>{algorithm.name}</option>)}</select></label>
        {state.algorithmId === 'raster.continuous-scribble' && <p className="panel-copy">One flowing line forms irregular, overlapping loops across the image, including highlights. Optional under-colour passes use solid colour-separated fills and are plotted before the main scribble; set their thicker pen widths and calibration under Pens &amp; passes. Lower Fine detail size preserves smaller features. Skip white / pale areas lifts the scribble pen across gaps.</p>}
        {state.algorithmId === 'raster.spiroglyph' && <p className="panel-copy">Image tone controls wave width. Choose two or more interleaved spirals for a multi-arm design; each arm uses the matching pen pass below, cycling through available passes.</p>}
        {state.algorithmId === 'raster.spiral-blocks' && <p className="panel-copy">Image tone controls dense radial blocks. Choose two or more interleaved spirals for a multi-arm design; each arm uses the matching pen pass below, cycling through available passes.</p>}
        {state.algorithmId === 'raster.scanlines' && <p className="panel-copy">Choose smooth waves or perpendicular blocks along each line. Image tone controls their width; line angle, spacing, thresholds and smoothing shape the result while the minimum gap prevents neighboring lines from merging.</p>}
        {(state.algorithmId === 'raster.paint-scribble' || state.algorithmId === 'raster.paint-scanlines') && <p className="panel-copy">This paint-aware variant stores image tone as brush pressure. Assign the pass to Paint below and enable variable Z to map highlights and shadows across the configured contact range.</p>}
        {state.algorithmId === 'generative.turtle' && <><p className="panel-copy">Runs standard TurtleToy code with <code>Canvas</code>, <code>new Turtle()</code> and optional <code>walk(i)</code>. <a href="https://turtletoy.net/syntax" target="_blank" rel="noreferrer">TurtleToy API reference</a>.</p><button className="button quiet full" disabled={render.active} onClick={() => setRedrawNonce((value) => value + 1)}><RefreshCw size={15} className={render.active ? 'spin' : undefined} /> Redraw</button><div className="source-placement"><label>Fit TurtleToy canvas<select value={state.turtlePlacement.fit} onChange={(event) => updateState({ turtlePlacement: { ...state.turtlePlacement, fit: event.target.value as ProjectState['turtlePlacement']['fit'] } })}><option value="contain">Contain — preserve scale</option><option value="cover">Cover — crop to fill</option><option value="stretch">Stretch — fill exactly</option></select></label><RangeField label="Canvas scale" unit="%" value={state.turtlePlacement.scalePercent} min={10} max={300} step={5} onChange={(value) => updateState({ turtlePlacement: { ...state.turtlePlacement, scalePercent: value } })} /><div className="field-row compact"><label>Offset X (mm)<input type="number" step="1" value={state.turtlePlacement.offsetXmm} onChange={(event) => updateState({ turtlePlacement: { ...state.turtlePlacement, offsetXmm: Number(event.target.value) } })} /></label><label>Offset Y (mm)<input type="number" step="1" value={state.turtlePlacement.offsetYmm} onChange={(event) => updateState({ turtlePlacement: { ...state.turtlePlacement, offsetYmm: Number(event.target.value) } })} /></label></div><button className="button quiet full" onClick={() => updateState({ turtlePlacement: { ...DEFAULT_TURTLE_PLACEMENT } })}>Reset TurtleToy canvas</button></div></>}
        {definition?.controls.filter(control => (!control.key.startsWith('underlay') || Boolean(state.algorithmSettings.colourUnderlay)) && (!control.visibleWhen || (state.algorithmSettings[control.visibleWhen.key] ?? definition.controls.find(item => item.key === control.visibleWhen?.key)?.default) === control.visibleWhen.value)).map((control) => control.type === 'textarea' ? <label key={control.key}>{control.label}<textarea rows={10} spellCheck={false} value={String(state.algorithmSettings[control.key] ?? control.default)} onChange={(event) => changeAlgorithmSettings({ ...state.algorithmSettings, [control.key]: event.target.value })} /></label> : control.type === 'boolean' ? <label className="check-field" key={control.key}><input type="checkbox" checked={Boolean(state.algorithmSettings[control.key] ?? control.default)} onChange={(event) => changeAlgorithmSettings({ ...state.algorithmSettings, [control.key]: event.target.checked })} /> {control.label}</label> : control.type === 'select' ? <label key={control.key}>{control.label}<select value={String(state.algorithmSettings[control.key] ?? control.default)} onChange={(event) => changeAlgorithmSettings({ ...state.algorithmSettings, [control.key]: event.target.value })}>{control.options?.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label> : <RangeField key={control.key} label={control.label} unit={control.unit} value={Number(state.algorithmSettings[control.key] ?? control.default)} min={control.min ?? 0} max={control.max ?? 100} step={control.step} numberOnly={control.type === 'number'} onChange={(value) => changeAlgorithmSettings({ ...state.algorithmSettings, [control.key]: value })} />)}
        <button className="button quiet full" onClick={() => changeAlgorithmSettings(algorithmDefaults(state.algorithmId))}><RefreshCw size={15} /> Reset {project.mode === 'raster' ? 'vectorisation' : 'generator'} settings</button>
      </Panel>}
      {state.algorithmId === 'raster.colour-separation' && <Panel title="Colours & pieces" open><ColourSeparationPanel state={state} updateState={updateState} selected={selectedRegion} setSelected={setSelectedRegion} /></Panel>}
      {(project.mode === 'svg' || project.mode === 'map') && <Panel title="Layers & treatments" open><VectorLayerEditor state={state} updateState={updateState} /></Panel>}
      <Panel title="Paper & safe area">
        <div className="field-row"><label>Width (mm)<input type="number" min="20" value={state.canvas.widthMm} onChange={(event) => updateState({ canvas: { ...state.canvas, preset: 'custom', widthMm: Number(event.target.value) } })} /></label><label>Height (mm)<input type="number" min="20" value={state.canvas.heightMm} onChange={(event) => updateState({ canvas: { ...state.canvas, preset: 'custom', heightMm: Number(event.target.value) } })} /></label></div>
        <label>Safe margin (mm)<input type="number" min="0" value={state.canvas.marginMm} onChange={(event) => updateState({ canvas: { ...state.canvas, marginMm: Number(event.target.value) } })} /></label>
      </Panel>
      {(project.mode === 'raster' || project.mode === 'generative') && <Panel title="Layers">
        {state.layers.map((layer) => <div className="layer-row" key={layer.id}><label className="check-field"><input type="checkbox" checked={layer.visible} onChange={(event) => updateState({ layers: state.layers.map((item) => item.id === layer.id ? { ...item, visible: event.target.checked } : item) })} /><span><strong>{layer.name}</strong><small>{definition?.name ?? layer.algorithmId}</small></span></label><span>{state.geometry.paths.filter((path) => path.layerId === layer.id).length.toLocaleString()}</span></div>)}
      </Panel>}
      <Panel title="Pens & passes">
        <PenPassEditor state={state} updateState={updateState} onCapturePaintWell={(penId, passName) => { setPaintCapture({ penId, passName }); setControlOpen(true); }} />
      </Panel>
      <Panel title="Post processing"><p className="panel-copy">Geometry is clipped to the safe area. G-code output uses nearest-neighbour path ordering and automatically chooses the shorter path direction.</p></Panel>
    </aside>
    <section className="workspace">
      <CanvasPreview state={state} updateState={updateState} selectedRegion={state.algorithmId === 'raster.colour-separation' && state.geometry.colourSeparation?.regions.some(r => r.id === selectedRegion) ? selectedRegion : undefined} />
      <div className={`render-status ${render.error ? 'failed' : ''}`}>
        {render.active && <div className="progress-track"><span style={{ width: `${Math.round(render.value * 100)}%` }} /></div>}
        <span>{render.error ?? render.message}</span><span>{state.geometry.paths.length.toLocaleString()} paths · {(drawingLength / 1000).toFixed(1)} m drawing</span>
      </div>
    </section>
    {gcodeOpen && <GCodeDrawer projectName={project.name} state={state} updateState={updateState} onOpenControl={() => { setPaintCapture(undefined); setControlOpen(true); }} onClose={() => setGcodeOpen(false)} />}
    {controlOpen && <FluidNCControlDialog capture={paintCapture ? { label: `${paintCapture.passName} paint well`, onCapture: (position: FluidNCPosition) => { updateState((current) => ({ ...current, pens: current.pens.map((pen) => pen.id === paintCapture.penId ? { ...pen, paintWellX: position.x, paintWellY: position.y } : pen) })); setPaintCapture(undefined); setControlOpen(false); } } : undefined} onClose={() => { setPaintCapture(undefined); setControlOpen(false); }} />}
  </div>;
}

function Panel({ title, open = false, children }: { title: string; open?: boolean; children: React.ReactNode }) {
  return <details className="panel" open={open}><summary>{title}<span>⌄</span></summary><div className="panel-content">{children}</div></details>;
}

function RangeField({ label, value, min, max, step = 1, unit, onChange, numberOnly }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange: (value: number) => void; numberOnly?: boolean }) {
  return <label className="range-field"><span><span>{label}</span><output>{value}{unit ?? ''}</output></span>{!numberOnly && <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />}<input className={numberOnly ? '' : 'sr-only'} type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function PenPassEditor({ state, updateState, onCapturePaintWell }: { state: ProjectState; updateState: (update: Partial<ProjectState> | ((state: ProjectState) => ProjectState)) => void; onCapturePaintWell: (penId: string, passName: string) => void }) {
  const updatePen = (id: string, update: Partial<PenProfile>) => updateState({ pens: state.pens.map((pen) => pen.id === id ? { ...pen, ...update } : pen) });
  const updatePass = (id: string, update: Partial<PlotPass>) => updateState({ passes: state.passes.map((pass) => pass.id === id ? { ...pass, ...update } : pass) });
  const addPass = () => {
    const index = state.passes.length + 1;
    const penId = `pen-${crypto.randomUUID()}`;
    updateState({ pens: [...state.pens, { id: penId, name: `Pen ${index}`, color: '#d84a35', widthMm: 0.3, zUp: 0, zDown: -10, xyFeed: 2500, zUpFeed: 600, zDownFeed: 600, mediaType: 'pen' }], passes: [...state.passes, { id: `pass-${crypto.randomUUID()}`, name: `Pass ${index}`, penId, enabled: true }] });
  };
  return <div className="pass-list">{state.passes.map((pass, index) => {
    const pen = state.pens.find((item) => item.id === pass.penId);
    if (!pen) return null;
    return <div className="pass-card" key={pass.id}>
      <div className="pass-head"><label className="check-field"><input type="checkbox" checked={pass.enabled} onChange={(event) => updatePass(pass.id, { enabled: event.target.checked })} /><strong>{pass.name}</strong></label>{state.passes.length > 1 && !pass.id.startsWith('colour-pass-') && !pass.id.startsWith('scribble-colour-pass-') && <button className="icon-button small" onClick={() => updateState({ passes: state.passes.filter((item) => item.id !== pass.id), pens: state.pens.filter((item) => item.id !== pen.id) })}><Trash2 /></button>}</div>
      <label>Pass name<input value={pass.name} onChange={(event) => updatePass(pass.id, { name: event.target.value })} /></label>
      <label>Media type<select value={pen.mediaType ?? 'pen'} onChange={(event) => { const mediaType = event.target.value as PenProfile['mediaType']; updatePen(pen.id, mediaType === 'paint' ? { mediaType, paintReloadDistanceMm: pen.paintReloadDistanceMm ?? 150, paintDipDwellSeconds: pen.paintDipDwellSeconds ?? 0.5, paintUsePressure: pen.paintUsePressure ?? true, paintMaxPressureZ: pen.paintMaxPressureZ ?? pen.zDown - 1 } : { mediaType }); }}><option value="pen">Pen</option><option value="paint">Paint / brush</option></select></label>
      <div className="pen-name"><input type="color" value={pen.color} onChange={(event) => updatePen(pen.id, { color: event.target.value })} /><input value={pen.name} onChange={(event) => updatePen(pen.id, { name: event.target.value })} /></div>
      <div className="field-row compact"><label>{pen.mediaType === 'paint' ? 'Brush width' : 'Width'}<input type="number" min="0.01" step="0.1" value={pen.widthMm} onChange={(event) => updatePen(pen.id, { widthMm: Number(event.target.value) })} /></label><label>XY feed<input type="number" step="100" value={pen.xyFeed} onChange={(event) => updatePen(pen.id, { xyFeed: Number(event.target.value) })} /></label></div>
      <div className="field-row compact"><label>Z up<input type="number" step="0.5" value={pen.zUp} onChange={(event) => updatePen(pen.id, { zUp: Number(event.target.value) })} /></label><label>{pen.mediaType === 'paint' ? 'Light contact Z' : 'Z down'}<input type="number" step="0.5" value={pen.zDown} onChange={(event) => updatePen(pen.id, { zDown: Number(event.target.value) })} /></label></div>
      <div className="field-row compact"><label>Z up feed<input type="number" min="1" step="50" value={pen.zUpFeed ?? pen.zFeed ?? 600} onChange={(event) => updatePen(pen.id, { zUpFeed: Number(event.target.value) })} /></label><label>Z down feed<input type="number" min="1" step="50" value={pen.zDownFeed ?? pen.zFeed ?? 600} onChange={(event) => updatePen(pen.id, { zDownFeed: Number(event.target.value) })} /></label></div>
      {pen.mediaType === 'paint' && <div className="paint-settings">
        <div className="paint-settings-head"><div><strong>Paint well</strong><small>Work coordinates used to reload this pass</small></div><button className="button quiet compact-button" type="button" onClick={() => onCapturePaintWell(pen.id, pass.name)}><LocateFixed size={14} /> Capture XY</button></div>
        <div className="field-row compact"><label>Well X<input type="number" step="0.1" value={pen.paintWellX ?? ''} placeholder="Capture" onChange={(event) => updatePen(pen.id, { paintWellX: event.target.value === '' ? undefined : Number(event.target.value) })} /></label><label>Well Y<input type="number" step="0.1" value={pen.paintWellY ?? ''} placeholder="Capture" onChange={(event) => updatePen(pen.id, { paintWellY: event.target.value === '' ? undefined : Number(event.target.value) })} /></label></div>
        <div className="field-row compact"><label>Dip Z<input type="number" step="0.1" value={pen.paintWellZ ?? ''} placeholder="Required" onChange={(event) => updatePen(pen.id, { paintWellZ: event.target.value === '' ? undefined : Number(event.target.value) })} /></label><label>Dip dwell (s)<input type="number" min="0" step="0.1" value={pen.paintDipDwellSeconds ?? 0.5} onChange={(event) => updatePen(pen.id, { paintDipDwellSeconds: Math.max(0, Number(event.target.value)) })} /></label></div>
        <label>Reload every (mm)<input type="number" min="0" step="10" value={pen.paintReloadDistanceMm ?? 150} onChange={(event) => updatePen(pen.id, { paintReloadDistanceMm: Math.max(0, Number(event.target.value)) })} /><small>Set to 0 to dip only once at the start of the pass.</small></label>
        <label className="check-field"><input type="checkbox" checked={pen.paintUsePressure ?? true} onChange={(event) => updatePen(pen.id, { paintUsePressure: event.target.checked })} /> Variable Z pressure from paint-aware algorithms</label>
        {(pen.paintUsePressure ?? true) && <label>Full pressure Z<input type="number" step="0.1" value={pen.paintMaxPressureZ ?? pen.zDown - 1} onChange={(event) => updatePen(pen.id, { paintMaxPressureZ: Number(event.target.value) })} /></label>}
      </div>}
      <small>{state.geometry.paths.filter((path) => path.passId === pass.id).length.toLocaleString()} paths</small>
    </div>;
  })}<button className="button quiet full" onClick={addPass}><Plus size={15} /> Add pass</button></div>;
}

function CanvasPreview({ state, updateState, selectedRegion }: { state: ProjectState; updateState: (update: Partial<ProjectState>) => void; selectedRegion?: string }) {
  const { canvas, geometry, pens, passes, viewport } = state;
  const previewPaths = geometry.generator === state.algorithmId ? geometry.paths : [];
  // Cache bounded chunks: rebuilding and stroking a million-point path on every
  // resize/zoom can dominate generation time and stall the editor.
  const previewChunks = useMemo(() => previewPaths.map(plotPath => {
    const chunks: Path2D[] = [];
    for (let start = 0; start < plotPath.points.length - 1; start += 4096) {
      const chunk = new Path2D();
      const first = plotPath.points[start]!;
      chunk.moveTo(first.x, first.y);
      const last = Math.min(plotPath.points.length - 1, start + 4096);
      for (let index = start + 1; index <= last; index++) {
        const point = plotPath.points[index]!;
        chunk.lineTo(point.x, point.y);
      }
      if (plotPath.closed && last === plotPath.points.length - 1) chunk.lineTo(plotPath.points[0]!.x, plotPath.points[0]!.y);
      chunks.push(chunk);
    }
    return { plotPath, chunks };
  }), [geometry, state.algorithmId]);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | undefined>(undefined);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [quality, setQuality] = useState<PreviewQuality>(() => {
    const saved = window.localStorage.getItem('plotbox.previewQuality');
    return saved === 'standard' || saved === 'ultra' ? saved : 'high';
  });
  const setView = (next: typeof viewport) => updateState({ viewport: next });
  const zoom = (factor: number, anchor?: { x: number; y: number }) => {
    const nextZoom = Math.max(0.2, Math.min(8, viewport.zoom * factor));
    const ratio = nextZoom / viewport.zoom;
    setView(anchor ? { zoom: nextZoom, x: anchor.x - (anchor.x - viewport.x) * ratio, y: anchor.y - (anchor.y - viewport.y) * ratio } : { ...viewport, zoom: nextZoom });
  };

  useEffect(() => {
    window.localStorage.setItem('plotbox.previewQuality', quality);
  }, [quality]);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;

    const draw = () => {
      const cssWidth = preview.clientWidth;
      const cssHeight = preview.clientHeight;
      if (!cssWidth || !cssHeight) return;

      const setting = PREVIEW_QUALITY[quality];
      const requestedScale = window.devicePixelRatio * setting.scale * Math.max(1, viewport.zoom);
      const dimensionScale = Math.min(setting.maxDimension / cssWidth, setting.maxDimension / cssHeight);
      const areaScale = Math.sqrt(setting.maxPixels / (cssWidth * cssHeight));
      const backingScale = Math.max(1, Math.min(requestedScale, dimensionScale, areaScale));
      const pixelWidth = Math.max(1, Math.round(cssWidth * backingScale));
      const pixelHeight = Math.max(1, Math.round(cssHeight * backingScale));
      if (preview.width !== pixelWidth) preview.width = pixelWidth;
      if (preview.height !== pixelHeight) preview.height = pixelHeight;

      const context = preview.getContext('2d');
      if (!context) return;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, pixelWidth, pixelHeight);
      context.fillStyle = '#fffdf8';
      context.fillRect(0, 0, pixelWidth, pixelHeight);

      const scaleX = pixelWidth / canvas.widthMm;
      const scaleY = pixelHeight / canvas.heightMm;
      context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
      context.save();
      context.beginPath();
      context.rect(0, 0, canvas.widthMm, canvas.heightMm);
      context.clip();

      context.strokeStyle = '#d8d4c9';
      context.lineWidth = 0.35;
      context.setLineDash([2, 2]);
      context.strokeRect(canvas.marginMm, canvas.marginMm, Math.max(0, canvas.widthMm - canvas.marginMm * 2), Math.max(0, canvas.heightMm - canvas.marginMm * 2));
      context.setLineDash([]);
      context.lineCap = 'round';
      context.lineJoin = 'round';

      for (const { plotPath, chunks } of previewChunks) {
        if (!state.layers.find((layer) => layer.id === plotPath.layerId)?.visible) continue;
        const plotPass = passes.find((pass) => pass.id === plotPath.passId);
        if (!plotPass?.enabled || plotPath.points.length < 2) continue;
        const pen = pens.find((item) => item.id === plotPass.penId);
        if (!pen) continue;

        context.globalAlpha = selectedRegion && plotPath.channel !== selectedRegion ? 0.12 : 1;
        context.strokeStyle = pen.color;
        context.lineWidth = Math.max(0.01, pen.widthMm);
        for (const chunk of chunks) context.stroke(chunk);
      }
      context.restore();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(preview);
    return () => observer.disconnect();
  }, [canvas.heightMm, canvas.marginMm, canvas.widthMm, pens, passes, previewChunks, quality, state.layers, viewport.zoom, selectedRegion]);

  return <div className="canvas-stage" onWheelCapture={(event) => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); zoom(event.deltaY < 0 ? 1.12 : 0.89, { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }); }} onPointerMove={(event) => {
    if (!drag.current) return;
    setView({ ...viewport, x: drag.current.vx + event.clientX - drag.current.x, y: drag.current.vy + event.clientY - drag.current.y });
  }} onPointerUp={(event) => { drag.current = undefined; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerLeave={() => { drag.current = undefined; }} onPointerDown={(event) => { drag.current = { x: event.clientX, y: event.clientY, vx: viewport.x, vy: viewport.y }; event.currentTarget.setPointerCapture(event.pointerId); }}>
    <div className="canvas-toolbar" onPointerDown={(event) => event.stopPropagation()}><button title="Zoom in" onClick={() => zoom(1.2)}><ZoomIn /></button><button title="Zoom out" onClick={() => zoom(0.8)}><ZoomOut /></button><button title="Fit paper" onClick={() => setView({ zoom: 1, x: 0, y: 0 })}><Maximize2 /></button><span>{Math.round(viewport.zoom * 100)}%</span><label className="preview-quality"><span>Preview</span><select aria-label="Preview quality" title="Preview quality" value={quality} onChange={(event) => setQuality(event.target.value as PreviewQuality)}>{Object.entries(PREVIEW_QUALITY).map(([value, setting]) => <option value={value} key={value}>{setting.label}</option>)}</select></label></div>
    <canvas ref={previewRef} className="paper" width={Math.max(1, Math.round(canvas.widthMm * 4))} height={Math.max(1, Math.round(canvas.heightMm * 4))} style={{ aspectRatio: `${canvas.widthMm}/${canvas.heightMm}`, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }} aria-label="Plot preview" />
  </div>;
}

function GCodeDrawer({ projectName, state, updateState, onOpenControl, onClose }: { projectName: string; state: ProjectState; updateState: (update: Partial<ProjectState>) => void; onOpenControl: () => void; onClose: () => void }) {
  const [split, setSplit] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(true);
  const [documents, setDocuments] = useState<GCodeDocument[]>([]);
  const [generation, setGeneration] = useState<RenderStatus>({ active: true, value: 0, message: 'Preparing G-code' });
  const [retry, setRetry] = useState(0);
  const [remoteFiles, setRemoteFiles] = useState<Record<string, { path?: string; action?: 'uploading' | 'running'; message?: string; error?: boolean }>>({});
  const workerRef = useRef<Worker | null>(null);
  const jobRef = useRef(0);
  const visibleLayerIds = state.layers.filter((layer) => layer.visible).map((layer) => layer.id);
  const visibleLayerKey = visibleLayerIds.join(',');
  const visiblePathCount = state.geometry.paths.reduce((count, path) => count + (visibleLayerIds.includes(path.layerId) ? 1 : 0), 0);

  useEffect(() => {
    workerRef.current?.terminate();
    const worker = new Worker(new URL('../workers/gcode.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;
    const jobId = ++jobRef.current;
    setDocuments([]);
    // Generated content may change while retaining the same filename. Require a
    // fresh upload before Run can be used so the UI never starts stale SD data.
    setRemoteFiles({});
    setGeneration({ active: true, value: 0, message: 'Starting G-code generation' });
    worker.onmessage = (event: MessageEvent<{ type: string; jobId: number; value?: number; message?: string; documents?: GCodeDocument[] }>) => {
      if (event.data.jobId !== jobRef.current) return;
      if (event.data.type === 'progress') setGeneration({ active: true, value: event.data.value ?? 0, message: event.data.message ?? 'Generating G-code' });
      if (event.data.type === 'complete') {
        setDocuments(event.data.documents ?? []);
        setGeneration({ active: false, value: 1, message: 'G-code ready' });
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      }
      if (event.data.type === 'error') {
        setGeneration({ active: false, value: 0, message: '', error: event.data.message ?? 'G-code generation failed.' });
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      }
    };
    worker.onerror = () => {
      if (jobId !== jobRef.current) return;
      setGeneration({ active: false, value: 0, message: '', error: 'The G-code worker stopped unexpectedly. You can try again.' });
      worker.terminate();
      if (workerRef.current === worker) workerRef.current = null;
    };
    worker.postMessage({ jobId, projectName, geometry: state.geometry, passes: state.passes, pens: state.pens, settings: state.gcode, pageHeight: state.canvas.heightMm, split, visibleLayerIds });
    return () => { jobRef.current += 1; worker.terminate(); if (workerRef.current === worker) workerRef.current = null; };
  }, [projectName, state.geometry, state.passes, state.pens, state.gcode, state.canvas.heightMm, split, visibleLayerKey, retry]);

  const cancel = () => {
    jobRef.current += 1;
    workerRef.current?.terminate();
    workerRef.current = null;
    setGeneration({ active: false, value: 0, message: 'Generation cancelled' });
  };
  const download = (document: GCodeDocument) => {
    const url = URL.createObjectURL(new Blob([document.content], { type: 'text/plain' }));
    const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = document.filename; anchor.click(); URL.revokeObjectURL(url);
  };
  const fluidNC = loadFluidNCSettings();
  const upload = async (document: GCodeDocument) => {
    if (!fluidNC) return;
    setRemoteFiles((current) => ({ ...current, [document.filename]: { action: 'uploading', message: 'Uploading to SD…' } }));
    try {
      const result = await api.uploadFluidNCFile({ address: fluidNC.websocketUrl, projectName, filename: document.filename, content: document.content });
      setRemoteFiles((current) => ({ ...current, [document.filename]: { path: result.path, message: `On SD at ${result.path}` } }));
    } catch (error) {
      setRemoteFiles((current) => ({ ...current, [document.filename]: { error: true, message: error instanceof Error ? error.message : 'Upload failed' } }));
    }
  };
  const run = async (document: GCodeDocument) => {
    if (!fluidNC) return;
    const remote = remoteFiles[document.filename];
    if (!remote?.path) return;
    setRemoteFiles((current) => ({ ...current, [document.filename]: { ...remote, action: 'running', message: 'Sending run command…' } }));
    try {
      await api.runFluidNCFile({ address: fluidNC.websocketUrl, path: remote.path });
      setRemoteFiles((current) => ({ ...current, [document.filename]: { path: remote.path, message: 'Run command sent to plotter' } }));
    } catch (error) {
      setRemoteFiles((current) => ({ ...current, [document.filename]: { path: remote.path, error: true, message: error instanceof Error ? error.message : 'Run command failed' } }));
    }
  };
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="drawer">
    <div className="modal-head"><div><p className="eyebrow">MACHINE OUTPUT</p><h2>G-code export</h2></div><div className="drawer-head-actions"><button className="button quiet" onClick={onOpenControl}><Cable size={15} /> Plotter control</button><button className="icon-button" onClick={onClose} aria-label="Close G-code export"><X /></button></div></div>
    <div className="drawer-content">
      <label>Coordinate origin<select value={state.gcode.origin} onChange={(event) => updateState({ gcode: { ...state.gcode, origin: event.target.value as 'top-left' | 'bottom-left' } })}><option value="bottom-left">Bottom-left</option><option value="top-left">Top-left</option></select></label>
      <div className="field-row"><label>Travel feed<input type="number" value={state.gcode.travelFeed} onChange={(event) => updateState({ gcode: { ...state.gcode, travelFeed: Number(event.target.value) } })} /></label><label>Join gap (mm)<input type="number" min="0" step="0.01" value={state.gcode.pathJoinTolerance ?? 0.15} onChange={(event) => updateState({ gcode: { ...state.gcode, pathJoinTolerance: Math.max(0, Number(event.target.value)) } })} /></label></div>
      <div className="field-row"><label>Park X<input type="number" value={state.gcode.parkX} onChange={(event) => updateState({ gcode: { ...state.gcode, parkX: Number(event.target.value) } })} /></label><label>Park Y<input type="number" value={state.gcode.parkY} onChange={(event) => updateState({ gcode: { ...state.gcode, parkY: Number(event.target.value) } })} /></label></div>
      <label className="check-field"><input type="checkbox" checked={state.gcode.pauseBetweenPasses} onChange={(event) => updateState({ gcode: { ...state.gcode, pauseBetweenPasses: event.target.checked } })} /> Pause between pen passes</label>
      <label className="check-field"><input type="checkbox" checked={state.gcode.includeComments} onChange={(event) => updateState({ gcode: { ...state.gcode, includeComments: event.target.checked } })} /> Include comments</label>
      <div className="segmented"><button className={!split ? 'active' : ''} onClick={() => setSplit(false)}>Combined file</button><button className={split ? 'active' : ''} onClick={() => setSplit(true)}>One per pass</button></div>
      {(generation.active || generation.error) && <div className={`export-progress${generation.error ? ' failed' : ''}`} role="status" aria-live="polite">
        <div><strong>{generation.error ?? generation.message}</strong><span>{generation.active ? `${Math.round(generation.value * 100)}%` : ''}</span></div>
        <div className="export-progress-track"><span style={{ width: `${Math.max(0, Math.min(100, generation.value * 100))}%` }} /></div>
        {generation.active && <small>You can keep editing in another tab while this runs.</small>}
      </div>}
      <div className="export-summary"><strong>{visiblePathCount.toLocaleString()} paths</strong><span>{documents.length ? `${documents.length} file${documents.length === 1 ? '' : 's'} · ` : ''}always pen-up and park after each pass</span></div>
      {!fluidNC && <div className="notice error">Configure a FluidNC instance from the projects page to upload and run files.</div>}
    </div>
    <div className="drawer-actions">
      {generation.active && <button className="button quiet" onClick={cancel}>Cancel</button>}
      {!generation.active && generation.value !== 1 && <button className="button primary" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={16} /> Generate again</button>}
      {documents.map((document) => {
        const remote = remoteFiles[document.filename];
        return <div className="plotter-file-actions" key={document.filename}>
          <strong title={document.filename}>{document.filename}</strong>
          {remote?.message && <small className={remote.error ? 'failed' : ''}>{remote.message}</small>}
          <div>
            <button className="button quiet" onClick={() => download(document)}><Download size={15} /> Download</button>
            <button className="button primary" disabled={!fluidNC || Boolean(remote?.action)} onClick={() => void upload(document)}><Upload size={15} /> {remote?.action === 'uploading' ? 'Uploading…' : remote?.path ? 'Upload again' : 'Upload to SD'}</button>
            <button className="button secondary" disabled={!fluidNC || !remote?.path || Boolean(remote.action)} onClick={() => void run(document)}><Play size={15} /> {remote?.action === 'running' ? 'Starting…' : 'Run'}</button>
          </div>
        </div>;
      })}
    </div>
    <section className="gcode-console">
      <button className="gcode-console-toggle" type="button" aria-expanded={consoleOpen} aria-controls="gcode-console-output" onClick={() => setConsoleOpen((open) => !open)}><span><Terminal size={14} /> Console</span>{consoleOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}</button>
      {consoleOpen && <pre id="gcode-console-output" className="gcode-preview">{documents[0]?.content.slice(0, 6000) || (generation.error ? `; ${generation.error}` : generation.active ? '; Building preview…' : '; Generation was cancelled')}</pre>}
    </section>
  </aside></div>;
}
