import { useEffect, useId, useMemo, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { Copy, MousePointer2, Redo2, RotateCw, Trash2, Undo2 } from 'lucide-react';
import { DEFAULT_ISOMETRIC, type IsometricTile, type ProjectState } from '@plotter/core';
import { buildIsometricScene, moveIsometricTile } from '@plotter/algorithms';

type Props = { state: ProjectState; updateState: (update: Partial<ProjectState>) => void; paperRef: RefObject<HTMLCanvasElement | null> };
type Snapshot = IsometricTile[] | undefined;

export function IsometricCanvasEditor({ state, updateState, paperRef }: Props) {
  const scene = useMemo(() => {
    try { return buildIsometricScene(state.canvas, state.isometric ?? {}, state.isometricGlyphs ?? []); }
    catch { return undefined; } // The render worker reports invalid page settings.
  }, [state.canvas, state.isometric, state.isometricGlyphs]);
  return scene ? <TileEditor state={state} updateState={updateState} paperRef={paperRef} scene={scene} /> : null;
}

function TileEditor({ state, updateState, paperRef, scene }: Props & { scene: ReturnType<typeof buildIsometricScene> }) {
  const settings = { ...DEFAULT_ISOMETRIC, ...state.isometric };
  const glyphs = state.isometricGlyphs ?? [];
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [brush, setBrush] = useState('');
  const [size, setSize] = useState({ width: 0, height: 0, left: 0, top: 0 });
  const [ghost, setGhost] = useState<IsometricTile>();
  const [undo, setUndo] = useState<Snapshot[]>([]);
  const [redo, setRedo] = useState<Snapshot[]>([]);
  const [message, setMessage] = useState('');
  const drag = useRef<{ tile: IsometricTile; x: number; y: number } | undefined>(undefined);
  const svgRef = useRef<SVGSVGElement>(null);
  const tileKey = JSON.stringify(settings.tiles);
  const lastTiles = useRef(tileKey);
  const clipId = useId();
  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    const measure = () => {
      const rect = paper.getBoundingClientRect(), parent = paper.parentElement!.getBoundingClientRect();
      setSize({ width: rect.width / state.viewport.zoom, height: rect.height / state.viewport.zoom, left: rect.left - parent.left + rect.width / 2 - state.viewport.x, top: rect.top - parent.top + rect.height / 2 - state.viewport.y });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(paper);
    return () => observer.disconnect();
  }, [paperRef, state.viewport.zoom, state.viewport.x, state.viewport.y]);
  useEffect(() => {
    // Generator resets and library reloads invalidate local edit history.
    // Autosave round-trips JSON, so compare content rather than array identity.
    if (tileKey !== lastTiles.current) { setUndo([]); setRedo([]); setSelected(undefined); }
    lastTiles.current = tileKey;
  }, [tileKey]);
  const commit = (tiles: Snapshot) => {
    setUndo(history => [...history.slice(-49), settings.tiles]); setRedo([]);
    lastTiles.current = JSON.stringify(tiles);
    updateState({ isometric: { ...settings, tiles } });
  };
  const travel = (back: boolean) => {
    const from = back ? undo : redo;
    if (!from.length) return;
    const next = from.at(-1);
    (back ? setRedo : setUndo)(history => [...history, settings.tiles]);
    (back ? setUndo : setRedo)(from.slice(0, -1));
    lastTiles.current = JSON.stringify(next);
    updateState({ isometric: { ...settings, tiles: next } });
    setSelected(undefined); setGhost(undefined);
  };
  const active = scene.tiles.find(tile => tile.id === selected);
  const activeGlyph = active && scene.byId.get(active.glyphId);
  const diamond = (u: number, v: number) => [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]].map(([du, dv]) => {
    const p = scene.project(u + du!, v + dv!); return `${p.x},${p.y}`;
  }).join(' ');
  const valid = (u: number, v: number) => u >= scene.min && u <= scene.max && v >= scene.min && v <= scene.max;
  const point = (event: PointerEvent<SVGElement>) => {
    const rect = svgRef.current!.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) return undefined;
    return scene.unproject({ x: (event.clientX - rect.left) / rect.width * state.canvas.widthMm, y: (event.clientY - rect.top) / rect.height * state.canvas.heightMm });
  };
  const start = (event: PointerEvent<SVGElement>, tile?: IsometricTile) => {
    if (event.altKey || event.button !== 0) return;
    event.stopPropagation(); event.preventDefault(); svgRef.current?.focus();
    const p = point(event); if (!p) return;
    setMessage('');
    if (brush) {
      const u = tile?.u ?? Math.round(p.x), v = tile?.v ?? Math.round(p.y);
      if (!valid(u, v)) { setMessage('Choose a cell inside the ground grid.'); return; }
      const added = { id: tile?.id ?? `tile-${crypto.randomUUID()}`, glyphId: brush, u, v, rotation: 0 };
      commit([...scene.tiles.filter(t => t.u !== u || t.v !== v), added]); setSelected(added.id);
    } else {
      setSelected(tile?.id);
      if (tile) {
        drag.current = { tile, x: p.x, y: p.y };
        svgRef.current!.setPointerCapture(event.pointerId);
      }
    }
  };
  const remove = () => { if (active) { commit(scene.tiles.filter(t => t.id !== active.id)); setSelected(undefined); } };
  const rotate = () => {
    if (active && activeGlyph?.role !== 'building') commit(scene.tiles.map(t => t.id === active.id ? { ...t, rotation: (t.rotation + 1) % 4 } : t));
  };
  const duplicate = () => {
    if (!active) return;
    for (let radius = 1; radius <= scene.max - scene.min + 1; radius++) for (let du = -radius; du <= radius; du++) for (let dv = -radius; dv <= radius; dv++) {
      if (Math.max(Math.abs(du), Math.abs(dv)) !== radius) continue;
      const u = active.u + du, v = active.v + dv;
      if (valid(u, v) && !scene.tiles.some(t => t.u === u && t.v === v)) {
        const copy = { ...active, id: `tile-${crypto.randomUUID()}`, u, v };
        commit([...scene.tiles, copy]); setSelected(copy.id); return;
      }
    }
    setMessage('The grid is full. Remove a tile to make room for a copy.');
  };
  const hitTiles = useMemo(() => editing ? scene.tiles.map(tile => ({ tile, polygons: scene.tileHitPolygons(tile) })) : [], [scene, editing]);
  const { canvas, viewport } = state;
  return <>
    <div className="iso-editor-toolbar" onPointerDown={event => event.stopPropagation()}>
      <button className={`button quiet compact-button${editing ? ' active' : ''}`} aria-pressed={editing} onClick={() => { setEditing(!editing); setGhost(undefined); drag.current = undefined; }}><MousePointer2 size={14} />{editing ? 'Finish editing' : 'Edit tiles'}</button>
      {editing && <>
        <select aria-label="Tile to place" value={brush} onChange={event => { setBrush(event.target.value); setSelected(undefined); }}>
          <option value="">Select & move tiles</option>
          {[...new Set(glyphs.map(g => g.categoryName ?? 'Tiles'))].map(category => <optgroup label={category} key={category}>{glyphs.filter(g => (g.categoryName ?? 'Tiles') === category).map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</optgroup>)}
        </select>
        <button title="Undo tile edit (Ctrl+Z)" aria-label="Undo tile edit" disabled={!undo.length} onClick={() => travel(true)}><Undo2 /></button>
        <button title="Redo tile edit (Ctrl+Shift+Z)" aria-label="Redo tile edit" disabled={!redo.length} onClick={() => travel(false)}><Redo2 /></button>
        <button title="Rotate ground tile (R)" aria-label="Rotate tile" disabled={!active || activeGlyph?.role === 'building'} onClick={rotate}><RotateCw /></button>
        <button title="Duplicate tile" aria-label="Duplicate tile" disabled={!active} onClick={duplicate}><Copy /></button>
        <button title="Remove tile (Delete)" aria-label="Remove tile" disabled={!active} onClick={remove}><Trash2 /></button>
      </>}
    </div>
    {editing && <>
      <svg ref={svgRef} className="iso-tile-overlay" tabIndex={0} role="application" aria-label="Isometric tile editor" viewBox={`0 0 ${canvas.widthMm} ${canvas.heightMm}`}
        style={{ width: size.width, height: size.height, left: size.left, top: size.top, transform: `translate(-50%, -50%) translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
        onPointerDown={event => start(event)} onPointerMove={event => {
          if (!drag.current) return;
          event.stopPropagation(); const p = point(event);
          setGhost(p ? { ...drag.current.tile, u: drag.current.tile.u + Math.round(p.x - drag.current.x), v: drag.current.tile.v + Math.round(p.y - drag.current.y) } : undefined);
        }} onPointerUp={event => {
          if (!drag.current) return;
          event.stopPropagation();
          if (ghost && valid(ghost.u, ghost.v) && (ghost.u !== drag.current.tile.u || ghost.v !== drag.current.tile.v)) commit(moveIsometricTile(scene.tiles, ghost.id, ghost.u, ghost.v));
          drag.current = undefined; setGhost(undefined);
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }} onPointerCancel={() => { drag.current = undefined; setGhost(undefined); }}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); travel(!event.shiftKey); }
          else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
          else if (event.key.toLowerCase() === 'r') rotate();
          else if (event.key === 'Escape') { setBrush(''); setSelected(undefined); drag.current = undefined; setGhost(undefined); }
          else if (active && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
            event.preventDefault();
            const u = active.u + (event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0);
            const v = active.v + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0);
            if (valid(u, v)) commit(moveIsometricTile(scene.tiles, active.id, u, v));
          }
        }}>
        <defs><clipPath id={clipId}><rect x={canvas.marginMm} y={canvas.marginMm} width={canvas.widthMm - canvas.marginMm * 2} height={canvas.heightMm - canvas.marginMm * 2} /></clipPath></defs>
        <g clipPath={`url(#${clipId})`}>
          {Array.from({ length: scene.max - scene.min + 2 }, (_, n) => n + scene.min - .5).flatMap(i => [
            [scene.project(i, scene.min - .5), scene.project(i, scene.max + .5)], [scene.project(scene.min - .5, i), scene.project(scene.max + .5, i)],
          ]).map(([a, b], i) => <line key={i} x1={a!.x} y1={a!.y} x2={b!.x} y2={b!.y} stroke="#23724b" strokeWidth=".12" opacity=".24" pointerEvents="none" />)}
          {hitTiles.filter(({ tile }) => state.layers.find(l => l.id === (scene.byId.get(tile.glyphId)?.role === 'terrain' ? 'iso-terrain' : scene.byId.get(tile.glyphId)?.role === 'building' ? 'iso-buildings' : 'iso-roads'))?.visible).map(({ tile, polygons }) => <g key={tile.id} className="iso-tile-hit" onPointerDown={event => start(event, tile)}>
            <title>{scene.byId.get(tile.glyphId)?.name ?? 'Road'} · {tile.u}, {tile.v}</title>
            <polygon points={diamond(tile.u, tile.v)} fill="transparent" />
            {polygons.map((polygon, i) => <polygon key={i} points={polygon.map(p => `${p.x},${p.y}`).join(' ')} fill="transparent" />)}
          </g>)}
          {active && <polygon points={diamond(active.u, active.v)} fill="#23724b22" stroke="#23724b" strokeWidth=".4" pointerEvents="none" />}
          {ghost && <g pointerEvents="none" opacity=".8"><polygon points={diamond(ghost.u, ghost.v)} fill={valid(ghost.u, ghost.v) ? '#23724b33' : '#b5404033'} stroke={valid(ghost.u, ghost.v) ? '#23724b' : '#b54040'} strokeWidth=".45" />{scene.tilePaths(ghost).filter(p => p.stroke !== 'none').map((path, i) => <polyline key={i} points={[...path.points, ...(path.closed ? [path.points[0]!] : [])].map(p => `${p.x},${p.y}`).join(' ')} stroke="#23724b" fill="none" strokeWidth=".22" />)}</g>}
        </g>
      </svg>
      <div className="iso-editor-hint" role="status">{message || (brush ? 'Click a cell to place or replace a tile.' : active ? `${activeGlyph?.name ?? 'Road'} · ${active.u}, ${active.v}` : 'Drag tiles to move · drop onto another tile to swap.')}<small>Arrows move selection · Alt-drag pans · wheel zooms · edits save with your project</small></div>
    </>}
  </>;
}
