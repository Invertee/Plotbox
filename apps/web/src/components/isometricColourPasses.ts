import type { IsometricGlyph, PenProfile, PlotPass } from '@plotter/core';
import { CITYSCAPE_PALETTE } from './isometricStarterGlyphs';

export function glyphColours(glyphs: IsometricGlyph[]): string[] {
  return [...new Set(glyphs.flatMap(g => g.paths.flatMap(p => [p.stroke, ...(p.paper ? [] : [p.fill])])).filter((c): c is string => !!c && /^#[0-9a-f]{6}$/i.test(c)))].sort();
}

/** Stable pass identities preserve user pen choices, calibration and names on reload. */
export function prepareGlyphColourPasses(glyphs: IsometricGlyph[], passes: PlotPass[], pens: PenProfile[], mapping: Record<string, string> = {}) {
  const nextPasses = [...passes], nextPens = [...pens], colourPasses = { ...mapping };
  for (const colour of glyphColours(glyphs)) {
    const assigned = nextPasses.find(p => p.id === mapping[colour]);
    if (assigned && nextPens.some(p => p.id === assigned.penId)) continue;
    const passId = `cityscape-pass-${colour.slice(1)}`, penId = `cityscape-pen-${colour.slice(1)}`;
    const name = CITYSCAPE_PALETTE.find(c => c.colour === colour)?.name ?? colour;
    const existing = nextPasses.find(p => p.id === passId);
    const targetPenId = existing?.penId ?? penId;
    if (!nextPens.some(p => p.id === targetPenId)) nextPens.push({ id: targetPenId, name, color: colour, widthMm: 0.2, zUp: 0, zDown: -10, xyFeed: 2500, zUpFeed: 600, zDownFeed: 600, mediaType: 'pen' });
    if (!existing) nextPasses.push({ id: passId, penId: targetPenId, name: `Cityscape · ${name}`, enabled: true });
    colourPasses[colour] = passId;
  }
  return { passes: nextPasses, pens: nextPens, colourPasses };
}
