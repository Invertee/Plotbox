import { describe, expect, it } from 'vitest';
import { buildOverpassQuery, mapDimensionsKm, osmDetailForBounds } from '../apps/server/src/maps';
import { boundsForView, dimensionsForBounds } from '../apps/web/src/components/MapRegionPicker';

describe('large map imports', () => {
  it('allows a selection of at least 50 square miles at the wider picker zoom', () => {
    const bounds = boundsForView({ latitude: 45.9237, longitude: 6.8694, zoom: 10 }, 190 / 277);
    const dimensions = dimensionsForBounds(bounds);

    expect(dimensions.areaKm2 / 2.58999).toBeGreaterThan(50);
    expect(dimensions.areaKm2).toBeLessThan(1_000);
  });

  it('selects map detail from physical area rather than latitude/longitude degrees', () => {
    expect(osmDetailForBounds({ north: 45.94, south: 45.92, east: 6.89, west: 6.87 })).toBe('detailed');
    expect(osmDetailForBounds({ north: 46.02, south: 45.92, east: 6.97, west: 6.87 })).toBe('regional');
    expect(osmDetailForBounds({ north: 46.12, south: 45.92, east: 7.07, west: 6.87 })).toBe('overview');

    const dimensions = mapDimensionsKm({ north: 46.02, south: 45.92, east: 6.97, west: 6.87 });
    expect(dimensions.widthKm).toBeGreaterThan(7);
    expect(dimensions.heightKm).toBeGreaterThan(11);
  });

  it('omits buildings, paths and minor roads from regional and overview queries', () => {
    const regional = buildOverpassQuery('45,6,46,7', 'regional');
    expect(regional).toContain('motorway|trunk|primary|secondary');
    expect(regional).not.toContain('["building"]');
    expect(regional).not.toContain('tertiary');
    expect(regional).toContain('["waterway"]');
    expect(regional).toContain('["boundary"="administrative"]');

    const overview = buildOverpassQuery('45,6,46,7', 'overview');
    expect(overview).toContain('motorway|trunk|primary');
    expect(overview).not.toContain('secondary');
    expect(overview).not.toContain('["building"]');
  });

  it('keeps full local detail for small map regions', () => {
    const detailed = buildOverpassQuery('45,6,45.01,6.01', 'detailed');
    expect(detailed).toContain('way["highway"]');
    expect(detailed).toContain('["building"]');
    expect(detailed).toContain('["leisure"="park"]');
  });
});
