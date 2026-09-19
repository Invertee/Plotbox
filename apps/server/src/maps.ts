import { createHash } from 'node:crypto';
import { getMapCache, setMapCache } from './database.js';
import { importTerrainContours } from './terrain.js';

const nominatimUrl = process.env.NOMINATIM_URL ?? 'https://nominatim.openstreetmap.org';
const overpassUrl = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';
const userAgent = process.env.PLOTBOX_USER_AGENT ?? 'Plotbox/0.2 (local pen-plotter application)';
let lastNominatimRequest = 0;

export type MapDataSource = 'openstreetmap' | 'terrain' | 'both';
export type OsmDetail = 'detailed' | 'regional' | 'overview';
type MapBounds = { north: number; south: number; east: number; west: number };

type NominatimResult = { place_id: number; display_name: string; lat: string; lon: string; type: string };
type OSMPoint = { lat: number; lon: number };
type OSMElement = {
  type: 'way' | 'relation' | 'node';
  id: number;
  tags?: Record<string, string>;
  geometry?: OSMPoint[];
  members?: Array<{ type: string; ref: number; role: string; geometry?: OSMPoint[] }>;
};

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function cachedFetch(key: string, request: () => Promise<Response>): Promise<string> {
  const cached = getMapCache(hash(key));
  if (cached) return cached;
  const response = await request();
  if (!response.ok) throw new Error(`Map provider returned ${response.status} ${response.statusText}`);
  const text = await response.text();
  setMapCache(hash(key), text);
  return text;
}

export async function searchPlaces(query: string) {
  const wait = 1000 - (Date.now() - lastNominatimRequest);
  if (wait > 0) await delay(wait);
  lastNominatimRequest = Date.now();
  const url = new URL('/search', nominatimUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('addressdetails', '0');
  const text = await cachedFetch(`nominatim:${url}`, () => fetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) }));
  return (JSON.parse(text) as NominatimResult[]).map((result) => ({ id: String(result.place_id), displayName: result.display_name, latitude: Number(result.lat), longitude: Number(result.lon), type: result.type }));
}

function categoryFor(tags: Record<string, string>): { category: string; name: string } | undefined {
  if (tags.highway) {
    if (['motorway', 'trunk', 'primary'].includes(tags.highway)) return { category: 'major-roads', name: 'Major roads' };
    if (['secondary', 'tertiary'].includes(tags.highway)) return { category: 'secondary-roads', name: 'Secondary roads' };
    return { category: 'local-roads', name: 'Local roads & paths' };
  }
  if (tags.railway) return { category: 'railways', name: 'Railways' };
  if (tags.building) return { category: 'buildings', name: 'Buildings' };
  if (tags.natural === 'water' || tags.water) return { category: 'water', name: 'Water' };
  if (tags.waterway) return { category: 'waterways', name: 'Waterways' };
  if (tags.leisure === 'park' || ['grass', 'forest', 'meadow', 'recreation_ground', 'village_green'].includes(tags.landuse ?? '')) return { category: 'parks', name: 'Parks & green space' };
  if (tags.boundary === 'administrative') return { category: 'boundaries', name: 'Administrative boundaries' };
  return undefined;
}

export function classifyOsmElements(elements: OSMElement[]) {
  const grouped = new Map<string, { name: string; category: string; features: Array<{ id: string; closed: boolean; points: Array<[number, number]> }> }>();
  for (const element of elements) {
    const category = categoryFor(element.tags ?? {});
    if (!category) continue;
    const geometries = element.geometry ? [element.geometry] : (element.members ?? []).filter((member) => member.geometry?.length && member.role !== 'inner').map((member) => member.geometry!);
    geometries.forEach((geometry, geometryIndex) => {
      if (geometry.length < 2) return;
      const first = geometry[0]!;
      const last = geometry[geometry.length - 1]!;
      const closed = Math.abs(first.lat - last.lat) < 1e-8 && Math.abs(first.lon - last.lon) < 1e-8;
      const layer = grouped.get(category.category) ?? { ...category, features: [] };
      layer.features.push({ id: `osm-${element.type}-${element.id}-${geometryIndex}`, closed, points: geometry.map((point) => [point.lon, point.lat]) });
      grouped.set(category.category, layer);
    });
  }
  const order = ['water', 'parks', 'buildings', 'boundaries', 'railways', 'major-roads', 'secondary-roads', 'local-roads', 'waterways'];
  return [...grouped.values()].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category));
}

export function mapDimensionsKm(bounds: MapBounds) {
  const heightKm = (bounds.north - bounds.south) * 111.32;
  const centreLatitude = (bounds.north + bounds.south) / 2 * Math.PI / 180;
  const widthKm = (bounds.east - bounds.west) * 111.32 * Math.cos(centreLatitude);
  return { widthKm, heightKm, areaKm2: widthKm * heightKm };
}

export function osmDetailForBounds(bounds: MapBounds): OsmDetail {
  const { areaKm2 } = mapDimensionsKm(bounds);
  if (areaKm2 <= 25) return 'detailed';
  if (areaKm2 <= 150) return 'regional';
  return 'overview';
}

export function buildOverpassQuery(bbox: string, detail: OsmDetail) {
  const roads = detail === 'detailed'
    ? `way["highway"](${bbox});`
    : detail === 'regional'
      ? `way["highway"~"^(motorway|trunk|primary|secondary)$"](${bbox});`
      : `way["highway"~"^(motorway|trunk|primary)$"](${bbox});`;
  const localDetail = detail === 'detailed' ? `
    way["building"](${bbox});
    way["leisure"="park"](${bbox});
    relation["leisure"="park"](${bbox});
    way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green)$"](${bbox});
    relation["landuse"~"^(grass|forest|meadow|recreation_ground|village_green)$"](${bbox});` : '';
  return `[out:json][timeout:80];(
    ${roads}
    way["railway"](${bbox});${localDetail}
    way["natural"="water"](${bbox});
    relation["natural"="water"](${bbox});
    way["waterway"](${bbox});
    way["boundary"="administrative"](${bbox});
  );out tags geom;`;
}

export async function importMap(input: MapBounds & { name: string; dataSource: MapDataSource; contourInterval?: number }) {
  const { south, west, north, east } = input;
  const includeOsm = input.dataSource !== 'terrain';
  const includeTerrain = input.dataSource !== 'openstreetmap';
  const bbox = `${south},${west},${north},${east}`;
  const detail = osmDetailForBounds(input);
  const query = buildOverpassQuery(bbox, detail);
  const osmPromise = includeOsm
    ? cachedFetch(`overpass:${query}`, () => fetch(overpassUrl, { method: 'POST', headers: { 'User-Agent': userAgent, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(95_000) }))
      .then((text) => classifyOsmElements((JSON.parse(text) as { elements?: OSMElement[] }).elements ?? []))
    : Promise.resolve([]);
  const terrainPromise = includeTerrain
    ? importTerrainContours({ north, south, east, west }, input.contourInterval ?? 10)
    : Promise.resolve([]);
  const [osmLayers, terrainLayers] = await Promise.all([osmPromise, terrainPromise]);
  const terrainAttribution = 'Terrain: Mapzen Terrain Tiles via AWS Open Data; source data includes ArcticDEM, Geoscience Australia, Open Data Austria, Canada Open Government data, Copernicus EU-DEM, NOAA ETOPO1, INEGI, LINZ, Kartverket, UK Environment Agency and USGS.';
  const attribution = input.dataSource === 'terrain'
    ? terrainAttribution
    : input.dataSource === 'openstreetmap'
      ? '© OpenStreetMap contributors · ODbL'
      : `Map data © OpenStreetMap contributors · ODbL. ${terrainAttribution}`;
  return { name: input.name, attribution, bounds: { north, south, east, west }, layers: [...terrainLayers, ...osmLayers] };
}
