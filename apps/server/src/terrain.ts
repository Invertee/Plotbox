import { PNG } from 'pngjs';
import { createHash } from 'node:crypto';
import { getMapCache, setMapCache } from './database.js';

const TILE_SIZE = 256;
const MAX_TERRAIN_ZOOM = 15;
const MAX_RASTER_DIMENSION = 1024;
const terrainTileUrl = process.env.TERRAIN_TILE_URL ?? 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
const userAgent = process.env.PLOTBOX_USER_AGENT ?? 'Plotbox/0.2 (local pen-plotter application)';

type PixelPoint = { x: number; y: number };
type Bounds = { north: number; south: number; east: number; west: number };
type ContourFeature = { id: string; closed: boolean; points: Array<[number, number]> };
export type TerrainLayer = { name: string; category: string; features: ContourFeature[] };

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const pointKey = (point: PixelPoint) => `${point.x.toFixed(5)},${point.y.toFixed(5)}`;

function longitudeToPixel(longitude: number, zoom: number) {
  return (longitude + 180) / 360 * 2 ** zoom * TILE_SIZE;
}

function latitudeToPixel(latitude: number, zoom: number) {
  const radians = latitude * Math.PI / 180;
  return (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * 2 ** zoom * TILE_SIZE;
}

function pixelToLongitude(pixel: number, zoom: number) {
  return pixel / (TILE_SIZE * 2 ** zoom) * 360 - 180;
}

function pixelToLatitude(pixel: number, zoom: number) {
  const mercator = Math.PI * (1 - 2 * pixel / (TILE_SIZE * 2 ** zoom));
  return Math.atan(Math.sinh(mercator)) * 180 / Math.PI;
}

function chooseZoom(bounds: Bounds) {
  for (let zoom = MAX_TERRAIN_ZOOM; zoom > 0; zoom -= 1) {
    const width = longitudeToPixel(bounds.east, zoom) - longitudeToPixel(bounds.west, zoom);
    const height = latitudeToPixel(bounds.south, zoom) - latitudeToPixel(bounds.north, zoom);
    if (width <= MAX_RASTER_DIMENSION && height <= MAX_RASTER_DIMENSION) return zoom;
  }
  return 0;
}

function interpolate(start: PixelPoint, end: PixelPoint, startValue: number, endValue: number, level: number): PixelPoint {
  const ratio = startValue === endValue ? 0.5 : (level - startValue) / (endValue - startValue);
  return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
}

function simplify(points: PixelPoint[], tolerance = 0.25): PixelPoint[] {
  if (points.length <= 2) return points;
  const squareTolerance = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const a = points[first]!;
    const b = points[last]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let farthest = -1;
    let farthestDistance = squareTolerance;
    for (let index = first + 1; index < last; index += 1) {
      const point = points[index]!;
      const ratio = lengthSquared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
      const x = a.x + ratio * dx;
      const y = a.y + ratio * dy;
      const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
      if (distance > farthestDistance) {
        farthest = index;
        farthestDistance = distance;
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return points.filter((_, index) => keep[index]);
}

function joinSegments(segments: Array<[PixelPoint, PixelPoint]>): Array<{ points: PixelPoint[]; closed: boolean }> {
  const endpoints = new Map<string, number[]>();
  segments.forEach(([start, end], index) => {
    for (const key of [pointKey(start), pointKey(end)]) endpoints.set(key, [...(endpoints.get(key) ?? []), index]);
  });
  const used = new Uint8Array(segments.length);
  const paths: Array<{ points: PixelPoint[]; closed: boolean }> = [];

  const walk = (startIndex: number, startKey: string) => {
    const points: PixelPoint[] = [];
    let segmentIndex: number | undefined = startIndex;
    let currentKey = startKey;
    while (segmentIndex !== undefined && !used[segmentIndex]) {
      used[segmentIndex] = 1;
      const [a, b] = segments[segmentIndex]!;
      const aKey = pointKey(a);
      const next = aKey === currentKey ? b : a;
      const current = aKey === currentKey ? a : b;
      if (!points.length) points.push(current);
      points.push(next);
      currentKey = pointKey(next);
      segmentIndex = endpoints.get(currentKey)?.find((candidate) => !used[candidate]);
    }
    const closed = points.length > 2 && pointKey(points[0]!) === pointKey(points[points.length - 1]!);
    if (closed) points.pop();
    return { points: simplify(points), closed };
  };

  segments.forEach((segment, index) => {
    if (used[index]) return;
    const startKey = [pointKey(segment[0]), pointKey(segment[1])].find((key) => endpoints.get(key)?.length === 1) ?? pointKey(segment[0]);
    const path = walk(index, startKey);
    if (path.points.length > 1) paths.push(path);
  });
  return paths;
}

/** Convert an elevation grid into joined contour paths using marching squares. */
export function contourGrid(values: Float32Array, width: number, height: number, interval: number) {
  if (width < 2 || height < 2 || values.length !== width * height || !Number.isFinite(interval) || interval <= 0) return new Map<number, Array<{ points: PixelPoint[]; closed: boolean }>>();
  const segmentsByLevel = new Map<number, Array<[PixelPoint, PixelPoint]>>();
  const addSegment = (level: number, start: PixelPoint, end: PixelPoint) => {
    const segments = segmentsByLevel.get(level) ?? [];
    segments.push([start, end]);
    segmentsByLevel.set(level, segments);
  };

  for (let y = 0; y < height - 1; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const topLeft = values[y * width + x]!;
      const topRight = values[y * width + x + 1]!;
      const bottomLeft = values[(y + 1) * width + x]!;
      const bottomRight = values[(y + 1) * width + x + 1]!;
      if (![topLeft, topRight, bottomLeft, bottomRight].every(Number.isFinite)) continue;
      const minimum = Math.min(topLeft, topRight, bottomLeft, bottomRight);
      const maximum = Math.max(topLeft, topRight, bottomLeft, bottomRight);
      // A level equal to the cell maximum only touches an isolated vertex or
      // plateau edge; it is not a contour crossing through the cell.
      for (let level = Math.ceil(minimum / interval) * interval; level < maximum; level += interval) {
        const crossings: Array<{ edge: number; point: PixelPoint }> = [];
        const edge = (edgeIndex: number, a: PixelPoint, b: PixelPoint, aValue: number, bValue: number) => {
          if ((aValue >= level) !== (bValue >= level)) crossings.push({ edge: edgeIndex, point: interpolate(a, b, aValue, bValue, level) });
        };
        edge(0, { x, y }, { x: x + 1, y }, topLeft, topRight);
        edge(1, { x: x + 1, y }, { x: x + 1, y: y + 1 }, topRight, bottomRight);
        edge(2, { x, y: y + 1 }, { x: x + 1, y: y + 1 }, bottomLeft, bottomRight);
        edge(3, { x, y }, { x, y: y + 1 }, topLeft, bottomLeft);
        if (crossings.length === 2) addSegment(level, crossings[0]!.point, crossings[1]!.point);
        else if (crossings.length === 4) {
          const byEdge = new Map(crossings.map((crossing) => [crossing.edge, crossing.point]));
          const centreHigh = (topLeft + topRight + bottomLeft + bottomRight) / 4 >= level;
          if (centreHigh === (topLeft >= level)) {
            addSegment(level, byEdge.get(0)!, byEdge.get(1)!);
            addSegment(level, byEdge.get(2)!, byEdge.get(3)!);
          } else {
            addSegment(level, byEdge.get(0)!, byEdge.get(3)!);
            addSegment(level, byEdge.get(1)!, byEdge.get(2)!);
          }
        }
      }
    }
  }
  return new Map([...segmentsByLevel].map(([level, segments]) => [level, joinSegments(segments)]));
}

async function fetchTile(zoom: number, x: number, y: number): Promise<PNG> {
  const url = terrainTileUrl.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y));
  const cacheKey = hash(`terrain:${url}`);
  const cached = getMapCache(cacheKey);
  let buffer: Buffer;
  if (cached) buffer = Buffer.from(cached, 'base64');
  else {
    const response = await fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'image/png' }, signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error(`Terrain provider returned ${response.status} ${response.statusText}`);
    buffer = Buffer.from(await response.arrayBuffer());
    setMapCache(cacheKey, buffer.toString('base64'));
  }
  const tile = PNG.sync.read(buffer);
  if (tile.width !== TILE_SIZE || tile.height !== TILE_SIZE) throw new Error(`Terrain provider returned an unsupported ${tile.width}×${tile.height} tile`);
  return tile;
}

export async function importTerrainContours(bounds: Bounds, interval: number): Promise<TerrainLayer[]> {
  const zoom = chooseZoom(bounds);
  const westPixel = longitudeToPixel(bounds.west, zoom);
  const eastPixel = longitudeToPixel(bounds.east, zoom);
  const northPixel = latitudeToPixel(bounds.north, zoom);
  const southPixel = latitudeToPixel(bounds.south, zoom);
  const tileWest = Math.floor(westPixel / TILE_SIZE);
  const tileEast = Math.floor(eastPixel / TILE_SIZE);
  const tileNorth = Math.floor(northPixel / TILE_SIZE);
  const tileSouth = Math.floor(southPixel / TILE_SIZE);
  const tileColumns = tileEast - tileWest + 1;
  const tileRows = tileSouth - tileNorth + 1;
  const tiles = await Promise.all(Array.from({ length: tileColumns * tileRows }, (_, index) => {
    const x = tileWest + index % tileColumns;
    const y = tileNorth + Math.floor(index / tileColumns);
    return fetchTile(zoom, x, y);
  }));

  const startX = Math.max(0, Math.floor(westPixel - tileWest * TILE_SIZE));
  const startY = Math.max(0, Math.floor(northPixel - tileNorth * TILE_SIZE));
  const endX = Math.min(tileColumns * TILE_SIZE - 1, Math.ceil(eastPixel - tileWest * TILE_SIZE));
  const endY = Math.min(tileRows * TILE_SIZE - 1, Math.ceil(southPixel - tileNorth * TILE_SIZE));
  const width = endX - startX + 1;
  const height = endY - startY + 1;
  const values = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const mosaicX = startX + x;
      const mosaicY = startY + y;
      const tileColumn = Math.floor(mosaicX / TILE_SIZE);
      const tileRow = Math.floor(mosaicY / TILE_SIZE);
      const tile = tiles[tileRow * tileColumns + tileColumn]!;
      const pixelIndex = ((mosaicY % TILE_SIZE) * TILE_SIZE + (mosaicX % TILE_SIZE)) * 4;
      values[y * width + x] = tile.data[pixelIndex]! * 256 + tile.data[pixelIndex + 1]! + tile.data[pixelIndex + 2]! / 256 - 32768;
    }
  }

  const contours = contourGrid(values, width, height, interval);
  const minor: ContourFeature[] = [];
  const index: ContourFeature[] = [];
  const originX = tileWest * TILE_SIZE + startX;
  const originY = tileNorth * TILE_SIZE + startY;
  for (const [elevation, paths] of contours) {
    const target = Math.round(elevation / interval) % 5 === 0 ? index : minor;
    paths.forEach((path, pathIndex) => target.push({
      id: `terrain-${elevation}-${pathIndex}`,
      closed: path.closed,
      points: path.points.map((point) => [pixelToLongitude(originX + point.x + 0.5, zoom), pixelToLatitude(originY + point.y + 0.5, zoom)]),
    }));
  }
  return [
    { name: `Contours · ${interval} m`, category: 'terrain-contours', features: minor },
    { name: `Index contours · ${interval * 5} m`, category: 'terrain-index-contours', features: index },
  ].filter((layer) => layer.features.length);
}
