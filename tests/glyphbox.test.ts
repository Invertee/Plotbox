import { describe, expect, it } from 'vitest';
import { upgradeGlyphLibrary, type GlyphAsset } from '../apps/web/src/components/Glyphbox';
import { CITYSCAPE_CATEGORY, CITYSCAPE_PALETTE, GREENSPACE_CATEGORY, WATERFRONT_CATEGORY, TREELINED_CATEGORY, ISOMETRIC_STARTER_ASSETS, ISOMETRIC_STARTER_CATEGORIES } from '../apps/web/src/components/isometricStarterGlyphs';
import { glyphColours, prepareGlyphColourPasses } from '../apps/web/src/components/isometricColourPasses';
import { buildIsometricScene, generateIsometric, planIsometricCells } from '../packages/algorithms/src/isometric';
import { createDefaultState, type IsometricGlyph } from '../packages/core/src';

const glyphs: IsometricGlyph[] = ISOMETRIC_STARTER_ASSETS.map(asset => ({ id: asset.id, name: asset.name, categoryId: asset.categoryId, role: asset.isometricRole!, terrain: asset.terrain, shoreMask: asset.shoreMask, treeLined: asset.treeLined, paths: asset.plotPaths! }));

describe('Glyphbox isometric starter collection', () => {
  it('contains varied low-rise, tall and shop architecture', () => {
    const buildings = ISOMETRIC_STARTER_ASSETS.filter(asset => asset.isometricRole === 'building' && asset.categoryId === CITYSCAPE_CATEGORY);
    expect(buildings).toHaveLength(18);
    expect(new Set(ISOMETRIC_STARTER_ASSETS.map(asset => asset.categoryId))).toEqual(new Set([CITYSCAPE_CATEGORY, GREENSPACE_CATEGORY, WATERFRONT_CATEGORY, TREELINED_CATEGORY]));
    expect(ISOMETRIC_STARTER_CATEGORIES.map(c => c.name)).toEqual(['Cityscape', 'Parks & green spaces', 'Coasts & lakes', 'Tree-lined roads']);
    for (const use of ['Residential', 'Commercial', 'Industrial']) expect(buildings.some(b => b.name.startsWith(use))).toBe(true);
    expect(buildings.some(b => b.name.includes('11 storeys'))).toBe(true);
    expect(buildings.every(asset => asset.plotPaths!.some(p => p.closed && p.fill !== 'none') && !/<(text|image)\b/.test(asset.svg))).toBe(true);
    expect(glyphColours(glyphs)).toEqual(CITYSCAPE_PALETTE.map(c => c.colour).sort());
  });

  it('includes plot-ready parks, trees and green-space tiles in the shared style', () => {
    const greenSpaces = ISOMETRIC_STARTER_ASSETS.filter(asset => asset.categoryId === GREENSPACE_CATEGORY);
    expect(greenSpaces).toHaveLength(10);
    expect(greenSpaces.every(asset => asset.isometricRole === 'terrain' && asset.terrain === 'park')).toBe(true);
    for (const use of ['Tree', 'Trees', 'Park', 'Green space']) expect(greenSpaces.some(asset => asset.name.startsWith(use))).toBe(true);
    expect(greenSpaces.every(asset => asset.plotPaths!.some(path => path.closed && path.fill !== 'none') && !/<(text|image)\b/.test(asset.svg))).toBe(true);
    expect(greenSpaces.some(asset => asset.name.includes('playground'))).toBe(true);
    expect(greenSpaces.some(asset => asset.name.includes('community garden'))).toBe(true);
  });

  it('provides a complete topology set for each road treatment', () => {
    const roles = new Set(['road-straight', 'road-corner', 'road-tee', 'road-cross', 'road-end']);
    for (const variant of ['avenue', 'signs', 'crossing', 'trees']) {
      const assets = ISOMETRIC_STARTER_ASSETS.filter(asset => asset.id.startsWith(`cityscape-${variant}-`));
      expect(assets).toHaveLength(5);
      expect(new Set(assets.map(asset => asset.isometricRole))).toEqual(roles);
    }
    expect(ISOMETRIC_STARTER_ASSETS.find(asset => asset.id === 'cityscape-crossing-road-cross')?.plotPaths?.some(p => p.points.some(q => q.elevation))).toBe(true);
  });

  it('adds the city collection once while preserving an older saved library', () => {
    const custom: GlyphAsset = { id: 'custom-building', name: 'My building', kind: 'isometric', svg: '<svg/>', createdAt: '2026-01-01' };
    const upgraded = upgradeGlyphLibrary({
      version: 1,
      categories: [{ id: 'old-architecture', name: 'Architecture', kind: 'isometric' }],
      assets: [custom],
    });
    expect(upgraded.version).toBe(7);
    expect(upgraded.assets).toContain(custom);
    expect(upgraded.assets).toHaveLength(1 + ISOMETRIC_STARTER_ASSETS.length);
    expect(upgradeGlyphLibrary(upgraded).assets).toHaveLength(upgraded.assets.length);
  });

  it('replaces v3 bundled assets while retaining uploads, map glyphs and their categories', () => {
    const custom: GlyphAsset = { id: 'my-house', name: 'My house', kind: 'isometric', categoryId: 'iso-architecture', svg: '<svg/>', createdAt: '' };
    const marker: GlyphAsset = { ...custom, id: 'starter-map-pin', kind: 'map' };
    const upgraded = upgradeGlyphLibrary({ version: 3, categories: [
      { id: 'iso-architecture', name: 'My buildings', kind: 'isometric' }, { id: 'iso-roads', name: 'Old roads', kind: 'isometric' },
    ], assets: [custom, marker, { ...custom, id: 'starter-iso-townhouse' }, { ...custom, id: 'starter-marked-road-straight' }] });
    expect(upgraded.assets).toContain(custom);
    expect(upgraded.assets).toContain(marker);
    expect(upgraded.assets.some(a => a.id === 'starter-iso-townhouse')).toBe(false);
    expect(upgraded.categories.some(c => c.id === 'iso-architecture')).toBe(true);
    expect(upgraded.categories.some(c => c.id === 'iso-roads')).toBe(false);
    const deleted = { ...upgraded, assets: upgraded.assets.filter(a => a.id !== 'cityscape-cottage') };
    expect(upgradeGlyphLibrary(deleted).assets.some(a => a.id === 'cityscape-cottage')).toBe(false);
  });

  it('adds green spaces to v4 libraries without restoring deleted city tiles', () => {
    const v4Assets = ISOMETRIC_STARTER_ASSETS.filter(asset => asset.categoryId === CITYSCAPE_CATEGORY && asset.id !== 'cityscape-cottage');
    const upgraded = upgradeGlyphLibrary({ version: 4, categories: [{ id: CITYSCAPE_CATEGORY, name: 'Cityscape', kind: 'isometric' }], assets: v4Assets });
    expect(upgraded.version).toBe(7);
    expect(upgraded.categories.some(category => category.id === GREENSPACE_CATEGORY)).toBe(true);
    expect(upgraded.assets.filter(asset => asset.categoryId === GREENSPACE_CATEGORY)).toHaveLength(10);
    expect(upgraded.assets.some(asset => asset.id === 'cityscape-cottage')).toBe(false);
  });

  it('preserves calibrated pens and custom colour assignments on reload', () => {
    const result = prepareGlyphColourPasses(glyphs, [], []);
    expect(result.passes).toHaveLength(6);
    result.pens[0]!.zDown = -2.4;
    result.passes[0]!.name = 'My calibrated pen';
    result.colourPasses['#db829c'] = result.passes[0]!.id;
    const reloaded = prepareGlyphColourPasses(glyphs, result.passes, result.pens, result.colourPasses);
    expect(reloaded).toEqual(result);
  });

  it('upgrades v5 artwork without losing names, categories, uploads or intentional deletions', () => {
    const cottage = ISOMETRIC_STARTER_ASSETS.find(a => a.id === 'cityscape-cottage')!;
    const custom = { ...cottage, id: 'uploaded-house', svg: '<svg/>', name: 'My drawing' };
    const upgraded = upgradeGlyphLibrary({ version: 5, categories: [], assets: [{ ...cottage, name: 'My cottage', categoryId: 'personal', svg: '<svg/>' }, custom] });
    expect(upgraded.assets.find(a => a.id === cottage.id)).toMatchObject({ name: 'My cottage', categoryId: 'personal', svg: cottage.svg });
    expect(upgraded.assets).toContain(custom);
    expect(upgraded.assets.some(a => a.id === 'cityscape-green-pond')).toBe(false);
    expect(upgraded.assets.filter(a => a.categoryId === WATERFRONT_CATEGORY)).toHaveLength(12);
    expect(upgradeGlyphLibrary(upgraded)).toEqual(upgraded);
  });

  it('replaces v6 parks in place and adds tree-lined roads without restoring deleted water tiles', () => {
    const park = ISOMETRIC_STARTER_ASSETS.find(a => a.id === 'cityscape-green-pond')!;
    const saved = { ...park, svg: '<svg>old park</svg>', name: 'My park', categoryId: 'saved-parks' };
    const upgraded = upgradeGlyphLibrary({ version: 6, categories: [], assets: [saved] });
    expect(upgraded.assets.find(a => a.id === park.id)).toMatchObject({ svg: park.svg, name: 'My park', categoryId: 'saved-parks' });
    expect(upgraded.assets.filter(a => a.treeLined)).toHaveLength(5);
    expect(upgraded.assets.some(a => a.categoryId === WATERFRONT_CATEGORY)).toBe(false);
  });

  it.each([1, 2])('mixes %s green lots into every full city block instead of making separate park districts', count => {
    const canvas = { preset: 'A3' as const, orientation: 'landscape' as const, widthMm: 420, heightMm: 297, marginMm: 10 };
    const scene = buildIsometricScene(canvas, { cells: 10, greenSpacesPerBlock: count, buildingCategories: [CITYSCAPE_CATEGORY] }, glyphs);
    for (const bu of [0, 1]) for (const bv of [0, 1]) {
      const block = scene.tiles.filter(t => Math.floor(t.u / 5) === bu && Math.floor(t.v / 5) === bv && !scene.byId.get(t.glyphId)?.role.startsWith('road-'));
      expect(block.filter(t => scene.byId.get(t.glyphId)?.terrain === 'park')).toHaveLength(count);
      expect(block.some(t => scene.byId.get(t.glyphId)?.role === 'building')).toBe(true);
    }
    const noParks = buildIsometricScene(canvas, { cells: 10, greenSpacesPerBlock: 0 }, glyphs);
    expect(noParks.tiles.some(t => noParks.byId.get(t.glyphId)?.terrain === 'park')).toBe(false);
  });

  it('keeps tree-lined road segments continuous and canopy silhouettes upright through rotation', () => {
    const canvas = { preset: 'A4' as const, orientation: 'portrait' as const, widthMm: 210, heightMm: 297, marginMm: 10 };
    const scene = buildIsometricScene(canvas, { cells: 12 }, glyphs);
    expect(scene.tiles.filter(t => t.u === 5 || t.v === 5).every(t => scene.byId.get(t.glyphId)?.treeLined)).toBe(true);
    const plain = buildIsometricScene(canvas, { cells: 12, treeLinedStreets: false }, glyphs);
    expect(plain.tiles.some(t => plain.byId.get(t.glyphId)?.treeLined)).toBe(false);
    const tree = glyphs.find(g => g.id === 'cityscape-trees-road-straight')!;
    const canopyIndex = tree.paths.findIndex(p => p.points.length === 48 && p.points.some(q => q.billboardX));
    expect(canopyIndex).toBeGreaterThan(0);
    const silhouettes = [0, 1, 2, 3].map(rotation => {
      const points = scene.tilePaths({ id: 'tree', glyphId: tree.id, u: 3, v: 3, rotation })[canopyIndex]!.points;
      return points.map(p => ({ x: p.x - points[0]!.x, y: p.y - points[0]!.y }));
    });
    for (const shape of silhouettes.slice(1)) shape.forEach((p, i) => { expect(p.x).toBeCloseTo(silhouettes[0]![i]!.x); expect(p.y).toBeCloseTo(silhouettes[0]![i]!.y); });
  });

  it('has contiguous coasts and lakes with complete shore corners and upright props', () => {
    const canvas = { preset: 'A4' as const, orientation: 'portrait' as const, widthMm: 210, heightMm: 297, marginMm: 10 };
    for (const landscape of ['coast', 'lake'] as const) {
      const settings = { landscape, cells: 12 };
      const scene = buildIsometricScene(canvas, settings, glyphs);
      const cells = planIsometricCells(settings, 0, 11);
      for (const cell of cells.filter(c => c.water)) {
        const tile = scene.tiles.find(t => t.u === cell.u && t.v === cell.v)!;
        const glyph = scene.byId.get(tile.glyphId)!;
        expect(glyph.role).toBe('terrain');
        if (cell.shoreMask) {
          expect(glyph.terrain).toBe('shore');
          const mask = glyph.shoreMask!;
          expect(((mask << tile.rotation | mask >> (4 - tile.rotation)) & 15)).toBe(cell.shoreMask);
        }
      }
      expect(scene.tiles.some(t => scene.byId.get(t.glyphId)?.role === 'building')).toBe(true);
      expect(scene.tiles.some(t => scene.byId.get(t.glyphId)?.terrain === 'water')).toBe(true);
    }
    const dock = glyphs.find(g => g.id === 'cityscape-water-dock')!;
    expect(dock.paths.some(p => p.points.some(q => (q.elevation ?? 0) > 0))).toBe(true);
    for (const name of ['fishing', 'cargo', 'shark', 'whale']) expect(glyphs.some(g => g.id.includes(`water-${name}`))).toBe(true);
  });

  it('renders the bundled coloured paths through page clipping and real pen passes', () => {
    const canvas = { preset: 'A4' as const, orientation: 'portrait' as const, widthMm: 210, heightMm: 297, marginMm: 10 };
    const state = createDefaultState('isometric', canvas), colours = prepareGlyphColourPasses(glyphs, state.passes, state.pens);
    const result = generateIsometric(canvas, { cells: 6, colourPasses: colours.colourPasses }, glyphs, colours.passes.map(p => p.id));
    expect(result.paths.length).toBeGreaterThan(1000);
    expect(new Set(result.paths.map(p => p.passId)).size).toBe(6);
    expect(result.paths.every(p => p.preserveGaps && p.points.every(q => Number.isFinite(q.x) && q.x >= 10 - 1e-7 && q.x <= 200 + 1e-7 && q.y >= 10 - 1e-7 && q.y <= 287 + 1e-7))).toBe(true);
  });
});
