import type { Point } from '@plotter/core';

export type RasterContourOptions = {
  threshold?: number;
  lowThresholdRatio?: number;
  minimumPoints?: number;
};

const OFFSETS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
] as const;

/**
 * Detects thin raster edges and joins neighbouring edge pixels into paths.
 * Unlike the legacy edge renderer, paths follow the local direction of an
 * edge rather than collecting qualifying samples into horizontal scan lines.
 */
export function traceRasterContours(
  luminance: ArrayLike<number>,
  width: number,
  height: number,
  options: RasterContourOptions = {},
): Point[][] {
  if (width < 3 || height < 3 || luminance.length < width * height) return [];

  const highThreshold = Math.max(1, options.threshold ?? 70);
  const lowThreshold = highThreshold * Math.max(0.05, Math.min(1, options.lowThresholdRatio ?? 0.4));
  const minimumPoints = Math.max(2, Math.round(options.minimumPoints ?? 3));
  const magnitudes = new Float32Array(width * height);
  const directions = new Uint8Array(width * height);

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = luminance[(y - 1) * width + x - 1]!;
      const top = luminance[(y - 1) * width + x]!;
      const topRight = luminance[(y - 1) * width + x + 1]!;
      const left = luminance[y * width + x - 1]!;
      const right = luminance[y * width + x + 1]!;
      const bottomLeft = luminance[(y + 1) * width + x - 1]!;
      const bottom = luminance[(y + 1) * width + x]!;
      const bottomRight = luminance[(y + 1) * width + x + 1]!;
      const gx = (-topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight) / 4;
      const gy = (-topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight) / 4;
      const index = y * width + x;
      magnitudes[index] = Math.hypot(gx, gy);

      // Quantise the gradient normal into the four axes used by non-maximum suppression.
      let angle = Math.atan2(gy, gx) * 180 / Math.PI;
      if (angle < 0) angle += 180;
      directions[index] = angle < 22.5 || angle >= 157.5 ? 0 : angle < 67.5 ? 1 : angle < 112.5 ? 2 : 3;
    }
  }

  const candidates = new Uint8Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const magnitude = magnitudes[index]!;
      if (magnitude < lowThreshold) continue;
      const direction = directions[index]!;
      const first = direction === 0 ? index - 1 : direction === 1 ? index - width + 1 : direction === 2 ? index - width : index - width - 1;
      const second = direction === 0 ? index + 1 : direction === 1 ? index + width - 1 : direction === 2 ? index + width : index + width + 1;
      if (magnitude >= magnitudes[first]! && magnitude >= magnitudes[second]!) candidates[index] = magnitude >= highThreshold ? 2 : 1;
    }
  }

  // Hysteresis keeps faint pixels only when they extend a confidently detected edge.
  const edges = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    if (candidates[index] === 2) { edges[index] = 1; stack.push(index); }
  }
  while (stack.length) {
    const index = stack.pop()!;
    const x = index % width;
    const y = Math.floor(index / width);
    for (const [dx, dy] of OFFSETS) {
      const neighbour = (y + dy) * width + x + dx;
      if (candidates[neighbour] && !edges[neighbour]) { edges[neighbour] = 1; stack.push(neighbour); }
    }
  }

  const neighboursOf = (index: number, onlyUnvisited: Uint8Array): number[] => {
    const x = index % width;
    const y = Math.floor(index / width);
    const neighbours: number[] = [];
    for (const [dx, dy] of OFFSETS) {
      const neighbour = (y + dy) * width + x + dx;
      if (!edges[neighbour] || onlyUnvisited[neighbour]) continue;
      // Prefer a cardinal connection around a filled 2x2 corner. This avoids
      // short diagonal shortcuts and makes the resulting paths less jagged.
      if (dx && dy && (edges[y * width + x + dx] || edges[(y + dy) * width + x])) continue;
      neighbours.push(neighbour);
    }
    return neighbours;
  };

  const visited = new Uint8Array(width * height);
  const paths: Point[][] = [];
  const trace = (start: number) => {
    const points: Point[] = [];
    let previous = -1;
    let current = start;
    while (!visited[current]) {
      visited[current] = 1;
      const currentX = current % width;
      const currentY = Math.floor(current / width);
      points.push({ x: currentX, y: currentY });
      const choices = neighboursOf(current, visited);
      if (!choices.length) break;
      if (previous < 0 || choices.length === 1) {
        previous = current;
        current = choices[0]!;
        continue;
      }
      const previousX = previous % width;
      const previousY = Math.floor(previous / width);
      const incomingX = currentX - previousX;
      const incomingY = currentY - previousY;
      choices.sort((a, b) => {
        const ax = a % width - currentX;
        const ay = Math.floor(a / width) - currentY;
        const bx = b % width - currentX;
        const by = Math.floor(b / width) - currentY;
        return (bx * incomingX + by * incomingY) - (ax * incomingX + ay * incomingY);
      });
      previous = current;
      current = choices[0]!;
    }
    const first = points[0];
    const last = points[points.length - 1];
    if (first && last && points.length > 3 && Math.max(Math.abs(first.x - last.x), Math.abs(first.y - last.y)) <= 1) points.push({ ...first });
    if (points.length >= minimumPoints) paths.push(points);
  };

  // Start open contours at endpoints, then consume branches and closed loops.
  for (let index = 0; index < edges.length; index += 1) {
    if (edges[index] && neighboursOf(index, visited).length <= 1) trace(index);
  }
  for (let index = 0; index < edges.length; index += 1) {
    if (edges[index] && !visited[index]) trace(index);
  }
  return paths;
}
