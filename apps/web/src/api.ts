import type { CanvasSettings, Project, ProjectMode, ProjectState, ProjectSummary } from '@plotter/core';
import type { ImportedMap, MapSearchResult } from './vectorSources';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  // A bodyless DELETE must not advertise an empty JSON payload: Fastify treats
  // that combination as malformed JSON and returns 400 before routing.
  if (options?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(body.error ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const api = {
  listProjects: () => request<ProjectSummary[]>('/api/projects'),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  createProject: (input: { name: string; mode: ProjectMode; canvas: Partial<CanvasSettings> }) => request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  saveProject: (id: string, name: string, state: ProjectState) => request<Project>(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify({ name, state }) }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  searchMaps: (query: string) => request<MapSearchResult[]>(`/api/maps/search?q=${encodeURIComponent(query)}`),
  importMap: (input: { north: number; south: number; east: number; west: number; name: string }) => request<ImportedMap>('/api/maps/import', { method: 'POST', body: JSON.stringify(input) }),
  uploadFluidNCFile: (input: { address: string; projectName: string; filename: string; content: string }) => request<{ path: string }>('/api/fluidnc/upload', { method: 'POST', body: JSON.stringify(input) }),
  runFluidNCFile: (input: { address: string; path: string }) => request<{ ok: true }>('/api/fluidnc/run', { method: 'POST', body: JSON.stringify(input) }),
};
