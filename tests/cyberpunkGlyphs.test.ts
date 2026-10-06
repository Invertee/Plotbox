import { describe, expect, it } from 'vitest';
import { CYBERPUNK_ASSETS, CYBERPUNK_CATEGORY, CYBERPUNK_PALETTE } from '../apps/web/src/components/isometricCyberpunkGlyphs';
import { ISOMETRIC_STARTER_ASSETS } from '../apps/web/src/components/isometricStarterGlyphs';
import { upgradeGlyphLibrary } from '../apps/web/src/components/Glyphbox';
import { glyphColours, prepareGlyphColourPasses } from '../apps/web/src/components/isometricColourPasses';
import { buildIsometricScene, generateIsometric, matchRoadGlyph } from '../packages/algorithms/src/isometric';
import type { IsometricGlyph } from '../packages/core/src';

const glyphs: IsometricGlyph[] = CYBERPUNK_ASSETS.map(a => ({
  id: a.id, name: a.name, role: a.isometricRole!, categoryId: a.categoryId, collectionId: a.collectionId,
  terrain: a.terrain, shoreMask: a.shoreMask, treeLined: a.treeLined, paths: a.plotPaths!,
}));
const canvas = { preset: 'A4' as const, orientation: 'portrait' as const, widthMm: 210, heightMm: 297, marginMm: 10 };
const settings = { cells: 12, buildingCategories: [CYBERPUNK_CATEGORY], roadCategories: [CYBERPUNK_CATEGORY] };

describe('Retrowave / Cyberpunk collection', () => {
  it('supplies distinct building views and plot-ready geometry for the whole city', () => {
    expect(new Set(CYBERPUNK_ASSETS.map(a => a.id)).size).toBe(CYBERPUNK_ASSETS.length);
    expect(glyphColours(glyphs)).toEqual(CYBERPUNK_PALETTE.map(c => c.colour).sort());
    for (const use of ['Residential', 'Industry', 'Shop', 'Tower', 'Street', 'Transit', 'Boat', 'Road', 'Waterfront']) {
      expect(glyphs.some(g => g.name.startsWith(`${use} · `)), use).toBe(true);
    }
    for (const asset of CYBERPUNK_ASSETS) {
      expect(ISOMETRIC_STARTER_ASSETS).toContain(asset);
      expect(asset.svg).not.toMatch(/<(text|image|filter)\b/);
      expect(asset.plotPaths!.every(p => p.points.length >= 2 && p.points.every(q => Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.elevation ?? 0))), asset.id).toBe(true);
    }
    for (const base of glyphs.filter(g => g.role === 'building' && g.id.endsWith('-view-0'))) {
      const views = glyphs.filter(g => g.id.startsWith(base.id.slice(0, -1)));
      expect(views).toHaveLength(4);
      expect(new Set(views.map(g => JSON.stringify(g.paths))).size, base.id).toBe(4);
    }
  });

  it('mixes all four building orientations across generated neighbourhoods and preserves them on redraw', () => {
    const scene = buildIsometricScene(canvas, settings, glyphs);
    const buildings = scene.tiles.filter(t => scene.byId.get(t.glyphId)?.role === 'building');
    expect(new Set(buildings.map(t => t.glyphId.slice(-1)))).toEqual(new Set(['0', '1', '2', '3']));
    const designs = [...new Set(buildings.map(t => t.glyphId.replace(/-view-\d$/, '')))];
    expect(designs.some(id => new Set(buildings.filter(t => t.glyphId.startsWith(id)).map(t => t.glyphId)).size > 1)).toBe(true);
    expect(buildIsometricScene(canvas, settings, glyphs).tiles).toEqual(scene.tiles);
    expect(buildIsometricScene(canvas, { ...settings, tiles: scene.tiles }, glyphs).tiles).toEqual(scene.tiles);
  });

  it('connects every road topology and includes cars in the generated traffic', () => {
    const roads = glyphs.filter(g => g.role.startsWith('road-'));
    for (let mask = 1; mask < 16; mask++) expect(matchRoadGlyph(mask, roads), `mask ${mask}`).toBeDefined();
    const scene = buildIsometricScene(canvas, settings, glyphs);
    expect(scene.tiles.some(t => t.glyphId.includes('road-traffic-'))).toBe(true);
    expect(scene.tiles.filter(t => t.roadMask).every(t => t.glyphId.startsWith('cyberpunk-road-'))).toBe(true);
    for (const name of ['sports car', 'taxi', 'van', 'cruiser']) expect(roads.some(g => g.name.includes(name))).toBe(true);
  });

  it.each(['coast', 'lake'] as const)('uses its own boats and connected waterfront in a %s scene', landscape => {
    const scene = buildIsometricScene(canvas, { ...settings, cells: 20, landscape, waterFeatures: true }, glyphs);
    for (const terrain of ['water', 'shore', 'feature']) expect(scene.tiles.some(t => scene.byId.get(t.glyphId)?.terrain === terrain), terrain).toBe(true);
    expect(scene.tiles.every(t => t.glyphId.startsWith('cyberpunk-'))).toBe(true);
  });

  it.each([7, 8, 9])('adds the pack to v%s libraries once without altering saved artwork or restoring deleted tiles', version => {
    const uploaded = { ...CYBERPUNK_ASSETS[0]!, id: 'my-upload', name: 'Custom house', svg: '<svg/>', plotPaths: [] };
    const renamed = { ...CYBERPUNK_ASSETS[1]!, name: 'My neon house', categoryId: 'personal' };
    const source = { version, categories: [{ id: 'personal', name: 'Personal', kind: 'isometric' as const }], assets: [uploaded, renamed] };
    const upgraded = upgradeGlyphLibrary(source);
    expect(upgraded.assets).toContain(uploaded);
    expect(upgraded.assets.find(a => a.id === renamed.id)).toEqual(renamed);
    expect(upgraded.assets.filter(a => a.id === renamed.id)).toHaveLength(1);
    expect(upgraded.assets.some(a => a.id === 'cityscape-cottage')).toBe(false);
    expect(upgraded.categories.filter(c => c.id === CYBERPUNK_CATEGORY)).toHaveLength(1);
    expect(CYBERPUNK_ASSETS.every(a => upgraded.assets.some(saved => saved.id === a.id))).toBe(true);
    const deleted = { ...upgraded, assets: upgraded.assets.filter(a => a.id !== CYBERPUNK_ASSETS[0]!.id) };
    expect(upgradeGlyphLibrary(deleted)).toEqual(deleted);
  });

  it('renders the collection through clipping and the six assigned pen passes', () => {
    const colours = prepareGlyphColourPasses(glyphs, [], []);
    expect(colours.passes).toHaveLength(6);
    const result = generateIsometric(canvas, { ...settings, cells: 6, colourPasses: colours.colourPasses }, glyphs, colours.passes.map(p => p.id));
    expect(result.paths.length).toBeGreaterThan(500);
    expect(new Set(result.paths.map(p => p.passId)).size).toBe(6);
    expect(result.paths.every(p => p.preserveGaps && p.points.every(q => Number.isFinite(q.x) && q.x >= 10 - 1e-7 && q.x <= 200 + 1e-7 && q.y >= 10 - 1e-7 && q.y <= 287 + 1e-7))).toBe(true);
  });
});
