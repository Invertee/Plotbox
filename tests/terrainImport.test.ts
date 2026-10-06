import { afterEach, describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
vi.mock('../apps/server/src/database.js', () => ({ getMapCache: () => undefined, setMapCache: () => {} }));
import { importTerrainData } from '../apps/server/src/terrain';

afterEach(() => vi.unstubAllGlobals());
describe('terrain height-grid import', () => {
  it('decodes Terrarium metres into a bounded, serializable geographic grid even on flat land', async () => {
    const png = new PNG({ width: 256, height: 256 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 128; png.data[i + 1] = 100; png.data[i + 2] = 128; png.data[i + 3] = 255;
    }
    const buffer = PNG.sync.write(png);
    const fetchMock = vi.fn(async () => new Response(buffer, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const bounds = { north: 0.01, south: 0, east: 0.01, west: 0 };
    const result = await importTerrainData(bounds, 20, true);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.terrain?.bounds).toEqual(bounds);
    expect(result.terrain?.width).toBeLessThanOrEqual(241);
    expect(result.terrain?.height).toBeLessThanOrEqual(241);
    expect(result.terrain!.elevations.length).toBe(result.terrain!.width * result.terrain!.height);
    expect(result.terrain!.elevations.every(value => value === 100.5)).toBe(true);
    expect(JSON.parse(JSON.stringify(result)).terrain).toEqual(result.terrain);
  });
});
