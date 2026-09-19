import { useEffect, useState } from 'react';
import { ArrowRight, Cable, CirclePlus, PenTool, Trash2, X } from 'lucide-react';
import type { Orientation, PaperPreset, ProjectMode, ProjectSummary } from '@plotter/core';
import { PAPER_SIZES, paperDimensions } from '@plotter/core';
import { api } from '../api';
import { loadFluidNCSettings } from '../fluidnc';
import { FluidNCSettingsDialog } from './FluidNC';

export function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showFluidNC, setShowFluidNC] = useState(false);
  const [error, setError] = useState('');
  const [deletingId, setDeletingId] = useState<string>();
  const load = () => api.listProjects().then(setProjects).catch((value: Error) => setError(value.message)).finally(() => setLoading(false));
  useEffect(() => { void load(); }, []);
  const remove = async (project: ProjectSummary) => {
    if (!window.confirm(`Delete “${project.name}”? This cannot be undone.`)) return;
    setDeletingId(project.id);
    setError('');
    try {
      await api.deleteProject(project.id);
      // Update the visible list immediately; the API response is already authoritative.
      setProjects((current) => current.filter((item) => item.id !== project.id));
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setDeletingId(undefined);
    }
  };
  return <main className="home-shell">
    <header className="home-header">
      <div className="brand"><span className="brand-mark"><PenTool size={20} /></span><div><strong>Plotbox</strong><small>Geometry to motion</small></div></div>
      <div className="header-actions"><button className="button quiet" onClick={() => setShowFluidNC(true)}><Cable size={17} /> {loadFluidNCSettings() ? 'FluidNC' : 'Add FluidNC'}</button><button className="button primary" onClick={() => setShowCreate(true)}><CirclePlus size={17} /> New project</button></div>
    </header>
    <section className="project-section">
      <div className="section-title"><div><h2>Projects</h2><p>{projects.length} saved locally</p></div></div>
      {error && <div className="notice error">{error}</div>}
      {loading ? <div className="empty-card">Loading projects…</div> : projects.length === 0 ? <button className="empty-card" onClick={() => setShowCreate(true)}><span className="empty-icon"><PenTool /></span><strong>Your plot table is clear</strong><span>Create a project and start with a test pattern, raster image or generative system.</span></button> : <div className="project-grid">
        {projects.map((project) => <article className="project-card" key={project.id}>
          <div className="project-thumbnail"><span>{project.mode.slice(0, 1).toUpperCase()}</span><div className="mini-lines" /></div>
          <div className="project-card-body">
            <div className="mode-chip">{project.mode}</div>
            <h3>{project.name}</h3>
            <p>{project.widthMm} × {project.heightMm} mm · edited {new Date(project.updatedAt).toLocaleDateString()}</p>
            <div className="card-actions"><button className="button quiet danger" aria-label={`Delete ${project.name}`} title="Delete project" disabled={deletingId === project.id} onClick={() => void remove(project)}><Trash2 size={16} /></button><button className="button secondary" onClick={() => onOpen(project.id)}>Open <ArrowRight size={16} /></button></div>
          </div>
        </article>)}
      </div>}
    </section>
    {showCreate && <NewProjectDialog onClose={() => setShowCreate(false)} onCreated={(id) => onOpen(id)} />}
    {showFluidNC && <FluidNCSettingsDialog onClose={() => setShowFluidNC(false)} />}
  </main>;
}

function NewProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('Untitled plot');
  const [mode, setMode] = useState<ProjectMode>('generative');
  const [preset, setPreset] = useState<PaperPreset>('A4');
  const [orientation, setOrientation] = useState<Orientation>('portrait');
  const [width, setWidth] = useState(210);
  const [height, setHeight] = useState(297);
  const [margin, setMargin] = useState(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dimensions = paperDimensions(preset, orientation, [width, height]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const project = await api.createProject({ name, mode, canvas: { preset, orientation, widthMm: width, heightMm: height, marginMm: margin } });
      onCreated(project.id);
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); setBusy(false); }
  };
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="modal" onSubmit={(event) => void submit(event)}>
      <div className="modal-head"><div><p className="eyebrow">NEW PROJECT</p><h2>Set up the paper</h2></div><button type="button" className="icon-button" onClick={onClose}><X /></button></div>
      <label>Project name<input value={name} autoFocus onChange={(event) => setName(event.target.value)} required /></label>
      <label>Mode<select value={mode} onChange={(event) => setMode(event.target.value as ProjectMode)}><option value="generative">Generative</option><option value="raster">Raster image</option><option value="svg">SVG import</option><option value="map">Map & topography</option></select></label>
      <div className="field-row"><label>Paper<select value={preset} onChange={(event) => setPreset(event.target.value as PaperPreset)}>{Object.keys(PAPER_SIZES).map((size) => <option key={size}>{size}</option>)}<option value="custom">Custom</option></select></label><label>Orientation<select value={orientation} onChange={(event) => setOrientation(event.target.value as Orientation)}><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label></div>
      {preset === 'custom' && <div className="field-row"><label>Width (mm)<input type="number" min="20" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label><label>Height (mm)<input type="number" min="20" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label></div>}
      <label>Safe margin (mm)<input type="number" min="0" max={Math.min(...dimensions) / 2 - 1} value={margin} onChange={(event) => setMargin(Number(event.target.value))} /></label>
      <div className="paper-summary"><span style={{ aspectRatio: `${dimensions[0]}/${dimensions[1]}` }} /><div><strong>{dimensions[0]} × {dimensions[1]} mm</strong><small>Drawable area {dimensions[0] - margin * 2} × {dimensions[1] - margin * 2} mm</small></div></div>
      {error && <div className="notice error">{error}</div>}
      <div className="modal-actions"><button type="button" className="button quiet" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button></div>
    </form>
  </div>;
}
