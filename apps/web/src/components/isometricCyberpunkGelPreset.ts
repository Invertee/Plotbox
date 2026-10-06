import { DEFAULT_ISOMETRIC, type ProjectState } from '@plotter/core';
import { prepareGlyphColourPasses } from './isometricColourPasses';
import { CYBERPUNK_GEL_CATEGORY, CYBERPUNK_GEL_PALETTE } from './isometricCyberpunkGelGlyphs';

export function cyberpunkGelPreset(state: ProjectState): Partial<ProjectState> {
  const s = { ...DEFAULT_ISOMETRIC, ...state.isometric };
  const glyphs = state.isometricGlyphs ?? [];
  const gel = glyphs.filter(g => g.collectionId === CYBERPUNK_GEL_CATEGORY);
  const { colourPasses, ...palette } = prepareGlyphColourPasses(gel, state.passes, state.pens, s.colourPasses);
  const gelIds = new Set(gel.map(g => g.id));
  const pen = (index: number) => colourPasses[CYBERPUNK_GEL_PALETTE[index]!.colour]!;
  return {
    ...palette,
    canvas: { ...state.canvas, paperColour: state.canvas.paperColour === 'black' ? 'black' : 'navy' },
    algorithmId: `isometric.${s.algorithm}`,
    isometric: {
      ...s, buildingCategories: [CYBERPUNK_GEL_CATEGORY], roadCategories: [CYBERPUNK_GEL_CATEGORY],
      useGlyphColours: true, fillMode: 'outline', showGrid: false, groundSurface: 'pavement', colourPasses,
      buildingPassId: pen(0), roadPassId: pen(2), gridPassId: pen(3),
      // A hand-arranged original city can change edition without losing any
      // placements, views or road connections. Unrelated custom tiles stay put.
      tiles: s.tiles?.map(tile => {
        const replacement = tile.glyphId.replace(/^cyberpunk-(?!gel-)/, 'cyberpunk-gel-');
        return gelIds.has(replacement) ? { ...tile, glyphId: replacement } : tile;
      }),
    },
  };
}
