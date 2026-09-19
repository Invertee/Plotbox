import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDefaultState, paperDimensions, type CanvasSettings, type ProjectMode } from '@plotter/core';
import { createProject, deleteProject, getProject, listProjects, updateProject } from './database.js';
import { importMap, mapDimensionsKm, searchPlaces, type MapDataSource } from './maps.js';

function fluidNCBaseUrl(address: string): URL {
  const value = address.trim();
  if (!value) throw new Error('FluidNC address is required');
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  const url = new URL(withProtocol.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:'));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('FluidNC must use an HTTP or WebSocket address');
  if (url.port === '81') url.port = '80';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function safePathPart(value: string, fallback: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80) || fallback;
}

const FLUIDNC_COMMAND_TIMEOUT_MS = 20_000;
// Writing to the controller's SD card is much slower than its HTTP commands,
// particularly with large G-code files or slower cards.
const FLUIDNC_UPLOAD_TIMEOUT_MS = 5 * 60_000;

async function fluidNCFetch(url: URL, options: RequestInit, timeoutMs = FLUIDNC_COMMAND_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

// Detailed continuous raster plots may contain several million vector points.
const app = Fastify({ logger: true, bodyLimit: 128 * 1024 * 1024 });
await app.register(cors, { origin: true });

app.get('/api/health', async () => ({ ok: true }));
app.get('/api/projects', async () => listProjects());
app.get<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
  const project = getProject(request.params.id);
  return project ?? reply.code(404).send({ error: 'Project not found' });
});

app.post<{ Body: { name?: string; mode?: ProjectMode; canvas?: Partial<CanvasSettings> } }>('/api/projects', async (request, reply) => {
  const name = request.body?.name?.trim();
  const mode = request.body?.mode;
  if (!name || !mode || !['generative', 'raster', 'svg', 'map'].includes(mode)) return reply.code(400).send({ error: 'A name and valid mode are required' });
  const preset = request.body.canvas?.preset ?? 'A4';
  const orientation = request.body.canvas?.orientation ?? 'portrait';
  const custom: [number, number] = [request.body.canvas?.widthMm ?? 210, request.body.canvas?.heightMm ?? 297];
  const [widthMm, heightMm] = paperDimensions(preset, orientation, custom);
  const canvas: CanvasSettings = { preset, orientation, widthMm, heightMm, marginMm: Math.max(0, request.body.canvas?.marginMm ?? 10) };
  const id = crypto.randomUUID();
  return reply.code(201).send(createProject({ id, name, mode, state: createDefaultState(mode, canvas) }));
});

app.put<{ Params: { id: string }; Body: { name?: string; state?: ReturnType<typeof createDefaultState> } }>('/api/projects/:id', async (request, reply) => {
  if (!request.body?.state) return reply.code(400).send({ error: 'Project state is required' });
  const project = updateProject(request.params.id, { name: request.body.name, state: request.body.state });
  return project ?? reply.code(404).send({ error: 'Project not found' });
});

app.delete<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
  return deleteProject(request.params.id) ? reply.code(204).send() : reply.code(404).send({ error: 'Project not found' });
});

app.get<{ Querystring: { q?: string } }>('/api/maps/search', async (request, reply) => {
  const query = request.query.q?.trim();
  if (!query || query.length < 2 || query.length > 160) return reply.code(400).send({ error: 'Enter a place name between 2 and 160 characters.' });
  try { return await searchPlaces(query); } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : 'Place search failed' }); }
});

app.post<{ Body: { north?: number; south?: number; east?: number; west?: number; name?: string; dataSource?: MapDataSource; includeTopography?: boolean; contourInterval?: number } }>('/api/maps/import', async (request, reply) => {
  const { north, south, east, west, name = 'Map import', contourInterval = 10 } = request.body ?? {};
  const dataSource = request.body?.dataSource ?? (request.body?.includeTopography ? 'both' : 'openstreetmap');
  const coordinates = [north, south, east, west];
  const coordinateValid = coordinates.every((value) => Number.isFinite(value))
    && north! > south! && east! > west!
    && Math.abs(north!) <= 85 && Math.abs(south!) <= 85 && Math.abs(east!) <= 180 && Math.abs(west!) <= 180;
  if (!coordinateValid) return reply.code(400).send({ error: 'Select a valid map region.' });
  const dimensions = mapDimensionsKm({ north: north!, south: south!, east: east!, west: west! });
  if (dimensions.areaKm2 > 1_000 || dimensions.widthKm > 60 || dimensions.heightKm > 60) return reply.code(400).send({ error: 'Select a region no larger than 1,000 km² (about 386 mi²) or 60 km across.' });
  if (!['openstreetmap', 'terrain', 'both'].includes(dataSource)) return reply.code(400).send({ error: 'Choose OpenStreetMap, terrain, or both.' });
  if (dataSource !== 'openstreetmap' && (!Number.isFinite(contourInterval) || contourInterval < 5 || contourInterval > 200)) return reply.code(400).send({ error: 'Contour interval must be between 5 and 200 metres.' });
  try { return await importMap({ north: north!, south: south!, east: east!, west: west!, name, dataSource, contourInterval }); } catch (error) { return reply.code(502).send({ error: error instanceof Error ? error.message : 'Map import failed' }); }
});

app.post<{ Body: { address?: string; projectName?: string; filename?: string; content?: string } }>('/api/fluidnc/upload', async (request, reply) => {
  const { address, projectName, filename, content } = request.body ?? {};
  if (!address || !projectName || !filename || typeof content !== 'string') return reply.code(400).send({ error: 'Address, project, filename and G-code are required' });
  const folder = safePathPart(projectName, 'plot');
  const file = safePathPart(filename, 'plot.gcode');
  const remotePath = `/${folder}/${file}`;
  try {
    const base = fluidNCBaseUrl(address);
    const folderUrl = new URL(`sd/${encodeURIComponent(folder)}`, base);
    const create = await fluidNCFetch(folderUrl, { method: 'MKCOL' });
    if (!create.ok && create.status !== 405) throw new Error(`FluidNC could not create the project folder (${create.status})`);
    const upload = await fluidNCFetch(
      new URL(`sd/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`, base),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: content,
      },
      FLUIDNC_UPLOAD_TIMEOUT_MS,
    );
    if (!upload.ok) throw new Error(`FluidNC rejected the upload (${upload.status})`);
    return { path: remotePath };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? 'FluidNC did not respond before the upload timed out' : error instanceof Error ? error.message : 'FluidNC upload failed';
    return reply.code(502).send({ error: message });
  }
});

app.post<{ Body: { address?: string; path?: string } }>('/api/fluidnc/run', async (request, reply) => {
  const { address, path } = request.body ?? {};
  if (!address || !path || !/^\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(path)) return reply.code(400).send({ error: 'A valid FluidNC address and SD path are required' });
  try {
    const commandUrl = new URL('/command', fluidNCBaseUrl(address));
    commandUrl.searchParams.set('plain', `$SD/Run=${path}`);
    const response = await fluidNCFetch(commandUrl, { method: 'GET' });
    const body = await response.text();
    if (!response.ok || /(?:error|alarm):/i.test(body)) throw new Error(body.trim() || `FluidNC rejected the run command (${response.status})`);
    return { ok: true as const };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError' ? 'FluidNC did not respond before the command timed out' : error instanceof Error ? error.message : 'FluidNC command failed';
    return reply.code(502).send({ error: message });
  }
});

const webDist = resolve(process.cwd(), '../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, wildcard: false });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'));
}

const port = Number(process.env.PORT ?? 8787);
// Bind to all container interfaces: Home Assistant publishes the add-on port
// separately, while local development can still reach it via localhost.
await app.listen({ port, host: process.env.HOST ?? '0.0.0.0' });
