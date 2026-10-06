import { describe, expect, it, vi } from 'vitest';
import { createDefaultState, PAPER_COLOURS, type IsometricGlyph, type PlotPath } from '../packages/core/src';
import { CYBERPUNK_GEL_ASSETS, CYBERPUNK_GEL_CATEGORY, CYBERPUNK_GEL_PALETTE, CYBERPUNK_GEL_PAPER } from '../apps/web/src/components/isometricCyberpunkGelGlyphs';
import { CYBERPUNK_ASSETS, CYBERPUNK_CATEGORY } from '../apps/web/src/components/isometricCyberpunkGlyphs';
import { ISOMETRIC_STARTER_ASSETS } from '../apps/web/src/components/isometricStarterGlyphs';
import { cyberpunkGelPreset } from '../apps/web/src/components/isometricCyberpunkGelPreset';
import { GLYPHBOX_STORAGE_KEY, loadGlyphLibrary, upgradeGlyphLibrary, type GlyphAsset } from '../apps/web/src/components/Glyphbox';
import { glyphColours, prepareGlyphColourPasses } from '../apps/web/src/components/isometricColourPasses';
import { buildIsometricScene, generateIsometric } from '../packages/algorithms/src/isometric';

const asGlyph = (a: GlyphAsset): IsometricGlyph => ({ id: a.id, name: a.name, categoryId: a.categoryId, collectionId: a.collectionId, role: a.isometricRole!, terrain: a.terrain, shoreMask: a.shoreMask, treeLined: a.treeLined, paths: a.plotPaths! });
const gel = CYBERPUNK_GEL_ASSETS.map(asGlyph), all = ISOMETRIC_STARTER_ASSETS.map(asGlyph);
const canvas = { preset: 'A4' as const, orientation: 'portrait' as const, widthMm: 210, heightMm: 297, marginMm: 10 };
const inkLength = (paths: PlotPath[]) => paths.reduce((total, p) => total + p.points.slice(1).reduce((sum, q, i) => sum + Math.hypot(q.x-p.points[i]!.x, q.y-p.points[i]!.y), 0), 0);

describe('Cyberpunk on dark paper', () => {
  it('uses six bright stroke colours with paper masks instead of ink-filled surfaces', () => {
    expect(CYBERPUNK_GEL_ASSETS).toHaveLength(CYBERPUNK_ASSETS.length);
    expect(glyphColours(gel)).toEqual(CYBERPUNK_GEL_PALETTE.map(p => p.colour).sort());
    expect(PAPER_COLOURS.navy).toBe(CYBERPUNK_GEL_PAPER);
    expect(gel.every(g => g.paths.every(p => !p.closed || (p.paper && p.fill === CYBERPUNK_GEL_PAPER)))).toBe(true);
    expect(gel.every(g => g.paths[0]!.stroke === 'none')).toBe(true);
    const waterTiles = gel.filter(g => ['water', 'shore', 'feature'].includes(g.terrain ?? ''));
    expect(waterTiles.every(g => g.paths[0]!.paper && g.paths[0]!.closed && g.paths[0]!.stroke === 'none')).toBe(true);
    expect(waterTiles.every(g => g.paths.slice(1).some(p => p.stroke !== 'none'))).toBe(true);
    expect(gel.some(g => g.paths.some(p => p.id.endsWith('-light') && p.points.length === 2))).toBe(true);
    expect(gel.every(g => g.paths.every(p => p.points.every(q => Number.isFinite(q.x) && Number.isFinite(q.y))))).toBe(true);
    const original = CYBERPUNK_ASSETS.find(a => a.id === 'cyberpunk-prism-tower-view-0')!;
    expect(original.plotPaths!.some(p => p.closed && !p.paper && p.fill !== 'none')).toBe(true);
  });

  it('adds the separate edition to saved libraries once, keeping renames, uploads and deletions', () => {
    const uploaded = { ...CYBERPUNK_ASSETS[0]!, id: 'custom', svg: '<svg/>', plotPaths: [] };
    const renamed = { ...CYBERPUNK_ASSETS[1]!, name: 'My saved house', categoryId: 'personal' };
    const migrated = upgradeGlyphLibrary({ version: 10, categories: [], assets: [uploaded, renamed] });
    expect(migrated.assets).toContain(uploaded);
    expect(migrated.assets).toContain(renamed);
    expect(migrated.assets.filter(a => a.collectionId === CYBERPUNK_GEL_CATEGORY)).toHaveLength(122);
    expect(migrated.assets.some(a => a.id === CYBERPUNK_ASSETS[0]!.id)).toBe(false);
    const deleted = { ...migrated, assets: migrated.assets.filter(a => a.id !== gel[0]!.id) };
    expect(upgradeGlyphLibrary(deleted)).toEqual(deleted);
  });

  it('persists the migration as artwork references and restores plot geometry on reload', () => {
    const store = new Map([[GLYPHBOX_STORAGE_KEY, JSON.stringify({ version: 10, categories: [], assets: [] })]]);
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key), setItem: (key: string, value: string) => store.set(key, value) });
    try {
      const first = loadGlyphLibrary();
      const saved = JSON.parse(store.get(GLYPHBOX_STORAGE_KEY)!);
      expect(saved.version).toBe(13);
      expect(saved.assets.every((a: { bundledArtwork?: boolean; svg?: string }) => a.bundledArtwork && !a.svg)).toBe(true);
      expect(loadGlyphLibrary()).toEqual(first);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each([11, 12])('refreshes v%s artwork and the stock name without restoring deleted tiles or changing custom names', version => {
    const water = CYBERPUNK_GEL_ASSETS.find(a => a.terrain === 'water')!;
    const saved = { ...water, name: 'My water', categoryId: 'personal', svg: '<svg>old borders</svg>' };
    const upgraded = upgradeGlyphLibrary({ version, categories: [{ id: CYBERPUNK_GEL_CATEGORY, name: 'Cyberpunk · dark paper / gel pens', kind: 'isometric' }], assets: [saved] });
    expect(upgraded.assets).toHaveLength(1);
    expect(upgraded.assets[0]).toMatchObject({ name: 'My water', categoryId: 'personal', svg: water.svg, plotPaths: water.plotPaths });
    expect(upgraded.categories[0]!.name).toBe('Dark retrowave/cyberpunk cityscape');
    expect(upgradeGlyphLibrary({ version: 11, categories: [{ id: CYBERPUNK_GEL_CATEGORY, name: 'My night city', kind: 'isometric' }], assets: [] }).categories[0]!.name).toBe('My night city');
  });

  it('applies the gel preset while preserving placements, orientations and pen calibration', () => {
    const state = createDefaultState('isometric', canvas);
    state.isometricGlyphs = all;
    state.isometric = { ...state.isometric!, tiles: [
      { id: 'house', glyphId: 'cyberpunk-courtyard-house-view-2', u: 3, v: 2, rotation: 0 },
      { id: 'road', glyphId: 'cyberpunk-road-neon-straight', u: 3, v: 1, rotation: 1 },
      { id: 'upload', glyphId: 'my-upload', u: 1, v: 1, rotation: 2 },
    ] };
    const first = cyberpunkGelPreset(state);
    expect(first.canvas!.paperColour).toBe('navy');
    expect(first.isometric!.tiles).toEqual(state.isometric.tiles!.map(t => ({ ...t, glyphId: t.glyphId.replace(/^cyberpunk-/, 'cyberpunk-gel-') })));
    expect(first.isometric).toMatchObject({ fillMode: 'outline', useGlyphColours: true, showGrid: false });
    const next = { ...state, ...first };
    const gelPen = next.pens.find(p => p.color === CYBERPUNK_GEL_PALETTE[0]!.colour)!;
    expect(gelPen.widthMm).toBe(.45);
    gelPen.widthMm = .7; gelPen.zDown = -2.3;
    next.canvas.paperColour = 'black';
    const reapplied = cyberpunkGelPreset(next);
    expect(reapplied.canvas!.paperColour).toBe('black');
    expect(reapplied.pens).toEqual(next.pens);
    expect(reapplied.isometric!.tiles).toEqual(next.isometric!.tiles);
  });

  it('keeps the six gel colours throughout the plotted city, including exposed paving, with all packs loaded', () => {
    const state = createDefaultState('isometric', canvas); state.isometricGlyphs = all;
    const preset = cyberpunkGelPreset(state);
    const settings = { ...preset.isometric!, cells: 6 };
    const result = generateIsometric(canvas, settings, all, preset.passes!.map(p => p.id));
    const allowed = new Set(CYBERPUNK_GEL_PALETTE.map(p => settings.colourPasses[p.colour]));
    expect(result.paths.length).toBeGreaterThan(100);
    expect(result.paths.every(p => allowed.has(p.passId))).toBe(true);
    expect(result.paths.some(p => p.id.startsWith('pavement-'))).toBe(true);
    expect(result.paths.every(p => p.preserveGaps && p.points.every(q => q.x >= 10 - 1e-7 && q.x <= 200 + 1e-7 && q.y >= 10 - 1e-7 && q.y <= 287 + 1e-7))).toBe(true);
    const hatch = generateIsometric(canvas, { ...settings, fillMode: 'hatch' }, all, preset.passes!.map(p => p.id));
    expect(hatch.paths).toEqual(result.paths);
    const originalGlyphs = CYBERPUNK_ASSETS.map(asGlyph);
    const palette = prepareGlyphColourPasses(originalGlyphs, [], []);
    const original = generateIsometric(canvas, { cells: 6, buildingCategories: [CYBERPUNK_CATEGORY], roadCategories: [CYBERPUNK_CATEGORY], colourPasses: palette.colourPasses }, originalGlyphs, palette.passes.map(p => p.id));
    expect(inkLength(result.paths)).toBeLessThan(inkLength(original.paths) * .75);
  });

  it('retains mixed building views and the gel boats and waterfront', () => {
    const scene = buildIsometricScene(canvas, { cells: 20, landscape: 'coast', buildingCategories: [CYBERPUNK_GEL_CATEGORY], roadCategories: [CYBERPUNK_GEL_CATEGORY] }, all);
    expect(scene.tiles.every(t => t.glyphId.startsWith('cyberpunk-gel-'))).toBe(true);
    expect(new Set(scene.tiles.filter(t => scene.byId.get(t.glyphId)?.role === 'building').map(t => t.glyphId.slice(-1)))).toEqual(new Set(['0', '1', '2', '3']));
    expect(scene.tiles.some(t => t.glyphId.includes('-boat-'))).toBe(true);
  });
});
