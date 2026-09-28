import { mkdirSync, writeFileSync } from 'node:fs';
import { ISOMETRIC_STARTER_ASSETS, CITYSCAPE_PALETTE } from '../apps/web/src/components/isometricStarterGlyphs';
import { generateIsometric } from '../packages/algorithms/src/isometric';
import { prepareGlyphColourPasses } from '../apps/web/src/components/isometricColourPasses';
import type { IsometricGlyph } from '../packages/core/src';

const out = 'artifacts/cityscape';
mkdirSync(out, { recursive: true });
const glyphs: IsometricGlyph[] = ISOMETRIC_STARTER_ASSETS.map(a => ({ id: a.id, name: a.name, role: a.isometricRole!, paths: a.plotPaths!, categoryId: a.categoryId }));
const palette = prepareGlyphColourPasses(glyphs, [], []);
const canvas = { preset: 'A3' as const, orientation: 'landscape' as const, widthMm: 420, heightMm: 297, marginMm: 12 };
const geometry = generateIsometric(canvas, { cells: 8, buildingScale: 0.8, fillSpacing: 0.45, colourPasses: palette.colourPasses }, glyphs, palette.passes.map(p => p.id));
const plot = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 297"><rect width="420" height="297" fill="#fff5df"/><g fill="none" stroke-width="0.2" stroke-linecap="round" stroke-linejoin="round">${geometry.paths.map(path => `<polyline stroke="${palette.pens.find(p => p.id === palette.passes.find(pass => pass.id === path.passId)?.penId)?.color}" points="${path.points.map(p => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ')}"/>`).join('')}</g></svg>`;
writeFileSync(`${out}/plot.svg`, plot);
writeFileSync(`${out}/index.html`, `<!doctype html><meta charset="utf-8"><title>Cityscape collection</title><style>body{background:#f1eee7;color:#343750;font:15px system-ui;margin:40px}h1{font-size:38px;margin-bottom:8px}p{color:#686879}.swatches{display:flex;flex-wrap:wrap;gap:24px;margin:24px 0}.swatches i{width:16px;height:16px;display:inline-block;border-radius:50%;margin-right:7px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:18px}article{background:#fffaf0;padding:18px;border:1px solid #dfdce0;border-radius:12px}article svg{height:200px;width:100%}article p{font-size:12px;min-height:32px}img{width:100%;background:#fff5df;border-radius:12px}h2{margin-top:40px}</style><h1>Cityscape</h1><p>18 buildings · 15 road tiles · six pen colours · one illustration system</p><div class="swatches">${CITYSCAPE_PALETTE.map(c => `<span><i style="background:${c.colour}"></i>${c.name}</span>`).join('')}</div><div class="grid">${ISOMETRIC_STARTER_ASSETS.map(a => `<article>${a.svg}<p>${a.name}</p></article>`).join('')}</div><h2>Actual pen paths · A3 · 0.45 mm hatching</h2><img src="plot.svg" alt="Plot-ready city assembled from Cityscape glyphs">`);
console.log(`${ISOMETRIC_STARTER_ASSETS.length} assets, ${geometry.paths.length} paths. Preview: ${out}/index.html`);
