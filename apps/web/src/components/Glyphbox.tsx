import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Check,
  FolderPlus,
  Layers3,
  MapPinned,
  Search,
  Shapes,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import type { IsometricRole, IsometricTerrain, SourcePath } from '@plotter/core';
import { GREENSPACE_CATEGORY, WATERFRONT_CATEGORY, TREELINED_CATEGORY, ISOMETRIC_STARTER_ASSETS, ISOMETRIC_STARTER_CATEGORIES } from './isometricStarterGlyphs';

export type GlyphKind = 'map' | 'isometric';

export type GlyphCategory = {
  id: string;
  name: string;
  kind: GlyphKind;
};

export type GlyphAsset = {
  id: string;
  name: string;
  kind: GlyphKind;
  categoryId?: string;
  svg: string;
  createdAt: string;
  isometricRole?: IsometricRole;
  terrain?: IsometricTerrain;
  shoreMask?: number;
  treeLined?: boolean;
  /** Bundled artwork shares exact vertices with its SVG preview. */
  plotPaths?: SourcePath[];
};

export type GlyphLibrary = {
  version: 7;
  categories: GlyphCategory[];
  assets: GlyphAsset[];
};

export const GLYPHBOX_STORAGE_KEY = 'plotbox.glyphbox.v1';
export const LEGACY_ISOMETRIC_STARTER_IDS = new Set([
  'starter-road-straight', 'starter-road-corner', 'starter-road-tee', 'starter-road-cross', 'starter-road-end',
  'starter-iso-house', 'starter-iso-tower',
  ...['townhouse', 'courtyard-house', 'roof-house', 'corner-flats', 'office', 'slim-tower', 'stepped-hotel', 'corner-shop', 'cafe', 'market'].map(id => `starter-iso-${id}`),
  ...['marked', 'signs', 'signals'].flatMap(variant => ['straight', 'corner', 'tee', 'cross', 'end'].map(role => `starter-${variant}-road-${role}`)),
]);
const LEGACY_CITY_CATEGORIES = new Set(['iso-architecture', 'iso-tall-buildings', 'iso-shopfronts', 'iso-roads', 'iso-roads-signs', 'iso-roads-signals']);

export const ISOMETRIC_ROLES: { value: IsometricRole; label: string }[] = [
  { value: 'terrain', label: 'Ground / water tile' },
  { value: 'building', label: 'Building' }, { value: 'road-straight', label: 'Road · straight (↘ ↖)' },
  { value: 'road-corner', label: 'Road · corner (↘ ↙)' }, { value: 'road-tee', label: 'Road · T junction (↘ ↙ ↖)' },
  { value: 'road-cross', label: 'Road · crossroads' }, { value: 'road-end', label: 'Road · end (↘)' },
];
const STARTER_LIBRARY: GlyphLibrary = {
  version: 7,
  categories: [
    { id: 'map-wayfinding', name: 'Wayfinding', kind: 'map' },
    ...ISOMETRIC_STARTER_CATEGORIES,
  ],
  assets: [
    ...ISOMETRIC_STARTER_ASSETS,
    {
      id: 'starter-north-arrow',
      name: 'North arrow',
      kind: 'map',
      categoryId: 'map-wayfinding',
      createdAt: new Date(0).toISOString(),
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 10 68 72 50 61 32 72Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M50 10v51" fill="none" stroke="currentColor" stroke-width="4"/><text x="50" y="92" text-anchor="middle" font-family="sans-serif" font-size="17">N</text></svg>',
    },
    {
      id: 'starter-map-pin',
      name: 'Location marker',
      kind: 'map',
      categoryId: 'map-wayfinding',
      createdAt: new Date(0).toISOString(),
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M50 89S22 61 22 38a28 28 0 1 1 56 0C78 61 50 89 50 89Z" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="50" cy="38" r="9" fill="none" stroke="currentColor" stroke-width="4"/></svg>',
    },
  ],
};

/** Replace only known bundled city assets. Preserve custom assets and any
 * categories they still use; migration does not restore deliberately deleted v4 tiles. */
export function upgradeGlyphLibrary(source: { version: number; categories: GlyphCategory[]; assets: GlyphAsset[] }): GlyphLibrary {
  if (source.version >= 7) return { version: 7, categories: source.categories, assets: source.assets };
  if (source.version >= 4) return {
    version: 7,
    categories: [...source.categories, ...ISOMETRIC_STARTER_CATEGORIES.filter(category => !source.categories.some(existing => existing.id === category.id))],
    assets: [...source.assets.map(asset => {
      const refreshed = ISOMETRIC_STARTER_ASSETS.find(starter => starter.id === asset.id);
      return refreshed ? { ...asset, svg: refreshed.svg, plotPaths: refreshed.plotPaths, isometricRole: refreshed.isometricRole, terrain: refreshed.terrain, shoreMask: refreshed.shoreMask, treeLined: refreshed.treeLined } : asset;
    }), ...ISOMETRIC_STARTER_ASSETS.filter(asset => (asset.categoryId === TREELINED_CATEGORY || (source.version < 6 && asset.categoryId === WATERFRONT_CATEGORY) || (source.version === 4 && asset.categoryId === GREENSPACE_CATEGORY)) && !source.assets.some(existing => existing.id === asset.id))],
  };
  const assets = source.assets.filter(asset => !LEGACY_ISOMETRIC_STARTER_IDS.has(asset.id));
  const categories = source.categories.filter(category => !LEGACY_CITY_CATEGORIES.has(category.id) || assets.some(asset => asset.categoryId === category.id));
  return {
    version: 7,
    categories: [...categories, ...ISOMETRIC_STARTER_CATEGORIES.filter(category => !categories.some(existing => existing.id === category.id))],
    assets: [...assets, ...ISOMETRIC_STARTER_ASSETS.filter(asset => !assets.some(existing => existing.id === asset.id))],
  };
}

export function loadGlyphLibrary(): GlyphLibrary {
  try {
    const saved = localStorage.getItem(GLYPHBOX_STORAGE_KEY);
    if (!saved) return STARTER_LIBRARY;
    const parsed = JSON.parse(saved) as { version?: number; categories?: GlyphCategory[]; assets?: GlyphAsset[] };
    if (![1, 2, 3, 4, 5, 6, 7].includes(parsed.version ?? 0) || !Array.isArray(parsed.categories) || !Array.isArray(parsed.assets)) return STARTER_LIBRARY;
    const library = upgradeGlyphLibrary({ version: parsed.version!, categories: parsed.categories, assets: parsed.assets });
    if (parsed.version !== library.version) {
      try { localStorage.setItem(GLYPHBOX_STORAGE_KEY, JSON.stringify(library)); } catch { /* Keep the migrated in-memory library if storage is full. */ }
    }
    return library;
  } catch {
    return STARTER_LIBRARY;
  }
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function svgUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function cleanSvg(source: string): string {
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.tagName.toLowerCase() !== 'svg') {
    throw new Error('Only valid SVG files can be added to Glyphbox.');
  }
  parsed.querySelectorAll('script, foreignObject, iframe, object, embed, image, use').forEach((element) => element.remove());
  parsed.querySelectorAll('*').forEach((element) => {
    [...element.attributes].forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on') || (name === 'href' && !attribute.value.startsWith('#')) || name === 'xlink:href') element.removeAttribute(attribute.name);
    });
  });
  const root = parsed.documentElement;
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return new XMLSerializer().serializeToString(root);
}

const KIND_COPY: Record<GlyphKind, { title: string; description: string }> = {
  map: { title: 'Map glyphs', description: 'Symbols and logos for landmarks, labels and map annotations.' },
  isometric: { title: 'Isometric tiles', description: 'Plot-ready forms designed to sit on an isometric grid.' },
};

export function GlyphboxDialog({ onClose, initialKind = 'map' }: { onClose: () => void; initialKind?: GlyphKind }) {
  const [library, setLibrary] = useState(loadGlyphLibrary);
  const [kind, setKind] = useState<GlyphKind>(initialKind);
  const [categoryId, setCategoryId] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [addingCategory, setAddingCategory] = useState(false);
  const [categoryName, setCategoryName] = useState('');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const commit = (next: GlyphLibrary) => {
    try {
      localStorage.setItem(GLYPHBOX_STORAGE_KEY, JSON.stringify(next));
      setLibrary(next);
      setError('');
    } catch {
      setError('Glyphbox could not save this change. Browser storage may be full.');
    }
  };

  const categories = library.categories.filter((category) => category.kind === kind);
  const visibleAssets = useMemo(() => library.assets.filter((asset) => {
    if (asset.kind !== kind) return false;
    if (categoryId !== 'all' && asset.categoryId !== categoryId) return false;
    return asset.name.toLowerCase().includes(query.trim().toLowerCase());
  }), [library.assets, kind, categoryId, query]);
  const selectedAssets = library.assets.filter((asset) => selectedIds.includes(asset.id));

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  const switchKind = (next: GlyphKind) => {
    setKind(next);
    setCategoryId('all');
    setSelectedIds([]);
    setQuery('');
    setAddingCategory(false);
  };

  const addCategory = () => {
    const name = categoryName.trim();
    if (!name) return;
    const category: GlyphCategory = { id: id('category'), name, kind };
    commit({ ...library, categories: [...library.categories, category] });
    setCategoryId(category.id);
    setCategoryName('');
    setAddingCategory(false);
  };

  const addFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError('');
    try {
      const additions = await Promise.all([...files].map(async (file): Promise<GlyphAsset> => {
        if (!file.name.toLowerCase().endsWith('.svg')) throw new Error(`${file.name} is not an SVG file.`);
        if (file.size > 750_000) throw new Error(`${file.name} is larger than 750 KB.`);
        return {
          id: id('glyph'),
          name: file.name.replace(/\.svg$/i, '').replace(/[-_]+/g, ' '),
          kind,
          categoryId: categoryId === 'all' ? undefined : categoryId,
          svg: cleanSvg(await file.text()),
          createdAt: new Date().toISOString(),
        };
      }));
      commit({ ...library, assets: [...library.assets, ...additions] });
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const toggleSelected = (assetId: string) => setSelectedIds((current) => current.includes(assetId) ? current.filter((item) => item !== assetId) : [...current, assetId]);

  const moveSelected = (nextCategoryId: string) => {
    commit({
      ...library,
      assets: library.assets.map((asset) => selectedIds.includes(asset.id) ? { ...asset, categoryId: nextCategoryId || undefined } : asset),
    });
    setSelectedIds([]);
  };

  const removeSelected = () => {
    if (!selectedIds.length || !window.confirm(`Remove ${selectedIds.length} ${selectedIds.length === 1 ? 'glyph' : 'glyphs'} from Glyphbox?`)) return;
    commit({ ...library, assets: library.assets.filter((asset) => !selectedIds.includes(asset.id)) });
    setSelectedIds([]);
  };

  const addCitySet = () => commit({
    ...library,
    categories: [...library.categories, ...ISOMETRIC_STARTER_CATEGORIES.filter(category => !library.categories.some(existing => existing.id === category.id))],
    assets: [...library.assets.map(asset => {
      const builtin = ISOMETRIC_STARTER_ASSETS.find(item => item.id === asset.id);
      return builtin ? { ...asset, name: asset.name.includes('\uFFFD') ? builtin.name : asset.name, svg: builtin.svg, plotPaths: builtin.plotPaths, isometricRole: builtin.isometricRole, terrain: builtin.terrain, shoreMask: builtin.shoreMask, treeLined: builtin.treeLined } : asset;
    }), ...ISOMETRIC_STARTER_ASSETS.filter(asset => !library.assets.some(existing => existing.id === asset.id))],
  });

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal glyphbox" role="dialog" aria-modal="true" aria-labelledby="glyphbox-title">
      <div className="modal-head glyphbox-head">
        <div><p className="eyebrow">DRAWING ASSET LIBRARY</p><h2 id="glyphbox-title">Glyphbox</h2><p>Reusable SVGs for map annotations and isometric drawings.</p></div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close Glyphbox"><X /></button>
      </div>

      <div className="glyphbox-kinds" role="tablist" aria-label="Glyph collection">
        {(['map', 'isometric'] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={kind === item} className={kind === item ? 'active' : ''} onClick={() => switchKind(item)}>
          <span>{item === 'map' ? <MapPinned /> : <Box />}</span><div><strong>{KIND_COPY[item].title}</strong><small>{KIND_COPY[item].description}</small></div>
        </button>)}
      </div>

      <div className="glyphbox-workspace">
        <aside className="glyphbox-sidebar">
          <div className="glyphbox-sidebar-title"><span>Categories</span><button type="button" onClick={() => setAddingCategory(true)} aria-label="Add category" title="Add category"><FolderPlus /></button></div>
          <button type="button" className={categoryId === 'all' ? 'active' : ''} onClick={() => setCategoryId('all')}><span><Layers3 /> All glyphs</span><small>{library.assets.filter((asset) => asset.kind === kind).length}</small></button>
          {categories.map((category) => <button type="button" key={category.id} className={categoryId === category.id ? 'active' : ''} onClick={() => setCategoryId(category.id)}><span><span className="category-dot" />{category.name}</span><small>{library.assets.filter((asset) => asset.categoryId === category.id).length}</small></button>)}
          {addingCategory && <form className="glyphbox-new-category" onSubmit={(event) => { event.preventDefault(); addCategory(); }}>
            <input aria-label="Category name" autoFocus placeholder="Category name" value={categoryName} onChange={(event) => setCategoryName(event.target.value)} />
            <button type="submit" aria-label="Save category" disabled={!categoryName.trim()}><Check /></button>
            <button type="button" aria-label="Cancel category" onClick={() => { setAddingCategory(false); setCategoryName(''); }}><X /></button>
          </form>}
        </aside>

        <div className="glyphbox-content">
          <div className="glyphbox-toolbar">
            <label className="glyphbox-search"><Search /><span className="sr-only">Search glyphs</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search glyphs" /></label>
            <input ref={fileInput} className="sr-only" type="file" accept=".svg,image/svg+xml" multiple onChange={(event) => void addFiles(event.target.files)} />
            <div className="field-row">{kind === 'isometric' && <button type="button" className="button quiet" onClick={addCitySet}>Restore built-in set</button>}<button type="button" className="button primary" onClick={() => fileInput.current?.click()}><Upload size={15} /> Add SVG</button></div>
          </div>

          {kind === 'isometric' && categoryId === 'iso-cityscape' && <p className="panel-copy">One illustrated city: homes, shops, offices and industry, with connected roads. Six pen colours; pale areas use the paper. Select Cityscape in a drawing to use the whole collection.</p>}
          {kind === 'isometric' && categoryId === GREENSPACE_CATEGORY && <p className="panel-copy">Leafy trees, stone planters, garden walks and pocket parks drawn to match the Cityscape buildings. Add one or two green spaces to each city block from the scene generator.</p>}
          {kind === 'isometric' && categoryId === TREELINED_CATEGORY && <p className="panel-copy">Five connected road shapes with paved verges and street trees. Enable Tree-lined avenues in the scene generator, or place these tiles by hand.</p>}
          {visibleAssets.length > 0 && <div className="glyphbox-selection"><span>{visibleAssets.length} glyphs</span><button type="button" className="button quiet" onClick={() => setSelectedIds(current => [...new Set([...current, ...visibleAssets.map(asset => asset.id)])])}>Select {categoryId === 'all' || query ? 'all shown' : 'category'}</button>{selectedIds.length > 0 && <button type="button" className="button quiet" onClick={() => setSelectedIds([])}>Clear selection</button>}</div>}
          {error && <div className="notice error">{error}</div>}
          {visibleAssets.length ? <div className="glyph-grid">
            {visibleAssets.map((asset) => {
              const selected = selectedIds.includes(asset.id);
              const category = library.categories.find((item) => item.id === asset.categoryId);
              return <button type="button" className={`glyph-card${selected ? ' selected' : ''}`} key={asset.id} title={asset.name} onClick={() => toggleSelected(asset.id)} aria-pressed={selected}>
                <span className="glyph-preview"><img src={svgUrl(asset.svg)} alt="" />{selected && <span className="glyph-check"><Check /></span>}</span>
                <span className="glyph-meta"><strong>{asset.name}</strong><small>{category?.name ?? 'Uncategorised'}{asset.kind === 'isometric' ? ' · ' + (asset.categoryId === GREENSPACE_CATEGORY ? 'Lot feature' : ISOMETRIC_ROLES.find(role => role.value === (asset.isometricRole ?? 'building'))?.label ?? 'Building') : ''}</small></span>
              </button>;
            })}
          </div> : <div className="glyph-empty">
            <span><Shapes /></span><strong>{query ? 'No matching glyphs' : `No ${kind === 'map' ? 'map glyphs' : 'isometric tiles'} here yet`}</strong>
            <p>{query ? 'Try a different search or category.' : 'Add plot-ready SVG files individually or in batches.'}</p>
            {!query && <button type="button" className="button" onClick={() => fileInput.current?.click()}><Upload size={15} /> Add your first SVG</button>}
          </div>}
        </div>
      </div>

      {kind === 'isometric' && selectedAssets.length > 0 && <div className="glyphbox-role-editor">
        <label>Use selected tiles as<select value="" onChange={event => commit({ ...library, assets: library.assets.map(asset => selectedIds.includes(asset.id) ? { ...asset, isometricRole: event.target.value as IsometricRole } : asset) })}><option value="" disabled>Choose tile role…</option>{ISOMETRIC_ROLES.map(role => <option key={role.value} value={role.value}>{role.label}</option>)}</select></label>
        <p>Road SVG viewBox must tightly frame the ground diamond. Arrows show connections in the original SVG; tiles rotate automatically. Buildings use their bottom centre as the ground anchor.</p>
      </div>}
      <div className="glyphbox-footer">
        <p>{selectedAssets.length ? `${selectedAssets.length} selected` : 'Categories act as groups when assets are brought into a drawing.'}</p>
        {selectedAssets.length > 0 && <div>
          <label><span className="sr-only">Move selected glyphs</span><select defaultValue="" onChange={(event) => moveSelected(event.target.value)}><option value="" disabled>Move to category…</option><option value="">Uncategorised</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
          <button type="button" className="button quiet danger" onClick={removeSelected}><Trash2 size={15} /> Remove</button>
        </div>}
      </div>
    </section>
  </div>;
}
