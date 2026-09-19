import { describe, expect, it } from 'vitest';
import { contourGrid } from '../apps/server/src/terrain';

describe('terrain contours', () => {
  it('joins marching-square segments into a closed contour around a peak', () => {
    const contours = contourGrid(new Float32Array([
      0, 0, 0,
      0, 20, 0,
      0, 0, 0,
    ]), 3, 3, 10);

    const paths = contours.get(10) ?? [];
    expect(paths).toHaveLength(1);
    expect(paths[0]?.closed).toBe(true);
    expect(paths[0]?.points.length).toBeGreaterThanOrEqual(4);
  });

  it('creates the requested levels and no contours for a flat grid', () => {
    const slope = contourGrid(new Float32Array([
      0, 10,
      0, 10,
    ]), 2, 2, 5);
    expect([...slope.keys()]).toEqual([5]);
    expect(slope.get(5)?.[0]?.points).toEqual([{ x: 0.5, y: 0 }, { x: 0.5, y: 1 }]);

    expect(contourGrid(new Float32Array([12, 12, 12, 12]), 2, 2, 5).size).toBe(0);
  });

  it('rejects invalid grids and intervals without producing paths', () => {
    expect(contourGrid(new Float32Array([0, 1]), 2, 2, 10).size).toBe(0);
    expect(contourGrid(new Float32Array([0, 1, 2, 3]), 2, 2, 0).size).toBe(0);
  });
});
