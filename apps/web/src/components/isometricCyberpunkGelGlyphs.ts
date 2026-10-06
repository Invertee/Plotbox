import type { Point, SourcePath } from '@plotter/core';
import type { GlyphAsset, GlyphCategory } from './Glyphbox';
import { CYBERPUNK_ASSETS, CYBERPUNK_PALETTE } from './isometricCyberpunkGlyphs';

export const CYBERPUNK_GEL_CATEGORY = 'iso-cyberpunk-gel';
export const CYBERPUNK_GEL_NAME = 'Dark retrowave/cyberpunk cityscape';
export const CYBERPUNK_GEL_PAPER = '#10172d';
export const CYBERPUNK_GEL_PALETTE = [
  { colour: '#e8f4ff', name: 'Gel · ice white' },
  { colour: '#ff74da', name: 'Gel · hot pink' },
  { colour: '#65f2ff', name: 'Gel · electric cyan' },
  { colour: '#c5a3ff', name: 'Gel · lilac' },
  { colour: '#ffe580', name: 'Gel · lemon yellow' },
  { colour: '#97ffd4', name: 'Gel · mint' },
];
const colours = new Map(CYBERPUNK_PALETTE.map((p, i) => [p.colour, CYBERPUNK_GEL_PALETTE[i]!.colour]));
const [INK, PINK, CYAN, PURPLE, AMBER] = CYBERPUNK_PALETTE.map(p => p.colour);
const litWindows = new Set([PINK, CYAN, AMBER]);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, elevation: ((a.elevation ?? 0) + (b.elevation ?? 0)) / 2 });
const round = (n: number) => Number(n.toFixed(5));

/** Keep the same silhouettes and four views, but use paper masks for every
 * surface. A roof or road is unmarked dark paper, never a dark ink fill.
 * Small solid windows become single gel strokes; pavement gets fewer lines. */
function gelAsset(source: GlyphAsset): GlyphAsset {
  let gridLine = 0;
  const paths: SourcePath[] = source.plotPaths!.flatMap((path, index) => {
    // The base has five joints in each direction. Keep only the middle pair,
    // rather than wrapping every building and pavement in a miniature grid.
    if (!path.closed && path.stroke === PURPLE && path.points.every(p => !p.elevation) && gridLine < 10) {
      const joint = gridLine++;
      if (joint !== 4 && joint !== 5) return [];
    }
    const points = path.points.map(p => ({ ...p }));
    if (!path.closed) return [{ ...path, points, stroke: colours.get(path.stroke!) ?? path.stroke }];
    // Coloured objects get their own luminous perimeter. White linework is
    // reserved for the pale structural faces of the original illustration.
    const stroke = path.stroke === INK && !path.paper ? colours.get(path.fill === INK ? CYAN! : path.fill!) : colours.get(path.stroke!);
    const mask: SourcePath = { ...path, points, fill: CYBERPUNK_GEL_PAPER, paper: true, stroke: stroke ?? colours.get(INK!) };
    // Keep the base diamond as an occlusion mask, without a drawn tile border.
    // Kerbs, building foundations and quays have their own separate outlines.
    if (index === 0) mask.stroke = 'none';
    if (points.length === 4 && path.fill === path.stroke && litWindows.has(path.fill)) {
      return [{ ...mask, stroke: 'none' }, {
        id: `${path.id}-light`, points: [midpoint(points[0]!, points[3]!), midpoint(points[1]!, points[2]!)],
        closed: false, fill: 'none', stroke: colours.get(path.stroke!),
      }];
    }
    return [mask];
  });
  // Reconstruct previews from the exact plot paths, using the source pack's
  // ground/building coordinate conventions. Background paint is preview-only.
  const viewBox = source.svg.match(/viewBox="([^"]+)"/)![1]!;
  const [left, top, width, height] = viewBox.split(' ').map(Number) as [number, number, number, number];
  const ground = source.isometricRole !== 'building';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="${CYBERPUNK_GEL_PAPER}"/><g stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round">${paths.map(p => `<${p.closed ? 'polygon' : 'polyline'} points="${p.points.map(q => `${round(left + q.x * width)},${round(ground ? q.y * 50 - 25 : top + q.y * width)}`).join(' ')}" fill="${p.fill}" stroke="${p.stroke}"/>`).join('')}</g></svg>`;
  return { ...source, id: source.id.replace('cyberpunk-', 'cyberpunk-gel-'), categoryId: CYBERPUNK_GEL_CATEGORY, collectionId: CYBERPUNK_GEL_CATEGORY, svg, plotPaths: paths };
}

export const CYBERPUNK_GEL_CATEGORIES: GlyphCategory[] = [{ id: CYBERPUNK_GEL_CATEGORY, name: CYBERPUNK_GEL_NAME, kind: 'isometric' }];
export const CYBERPUNK_GEL_ASSETS: GlyphAsset[] = CYBERPUNK_ASSETS.map(gelAsset);
