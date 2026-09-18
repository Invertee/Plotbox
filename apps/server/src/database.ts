import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Project, ProjectMode, ProjectState, ProjectSummary } from '@plotter/core';

const databasePath = process.env.PLOTTER_DATABASE ?? resolve(process.cwd(), '../../data/plotter.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mode TEXT NOT NULL,
    width_mm REAL NOT NULL,
    height_mm REAL NOT NULL,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS map_cache (
    query_hash TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
`);

type ProjectRow = {
  id: string; name: string; mode: ProjectMode; width_mm: number; height_mm: number;
  state_json: string; created_at: string; updated_at: string;
};

const toSummary = (row: ProjectRow): ProjectSummary => ({
  id: row.id,
  name: row.name,
  mode: row.mode,
  widthMm: row.width_mm,
  heightMm: row.height_mm,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function listProjects(): ProjectSummary[] {
  return (db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all() as ProjectRow[]).map(toSummary);
}

export function getProject(id: string): Project | undefined {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  return row ? { ...toSummary(row), state: JSON.parse(row.state_json) as ProjectState } : undefined;
}

export function createProject(input: { id: string; name: string; mode: ProjectMode; state: ProjectState }): Project {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO projects (id, name, mode, width_mm, height_mm, state_json, created_at, updated_at)
    VALUES (@id, @name, @mode, @width, @height, @state, @createdAt, @updatedAt)`)
    .run({ id: input.id, name: input.name, mode: input.mode, width: input.state.canvas.widthMm, height: input.state.canvas.heightMm, state: JSON.stringify(input.state), createdAt: now, updatedAt: now });
  return getProject(input.id)!;
}

export function updateProject(id: string, input: { name?: string; state: ProjectState }): Project | undefined {
  const existing = getProject(id);
  if (!existing) return undefined;
  const now = new Date().toISOString();
  db.prepare(`UPDATE projects SET name = ?, width_mm = ?, height_mm = ?, state_json = ?, updated_at = ? WHERE id = ?`)
    .run(input.name ?? existing.name, input.state.canvas.widthMm, input.state.canvas.heightMm, JSON.stringify(input.state), now, id);
  return getProject(id);
}

export function deleteProject(id: string): boolean {
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}

export function getMapCache(key: string): string | undefined {
  return (db.prepare('SELECT response FROM map_cache WHERE query_hash = ?').get(key) as { response: string } | undefined)?.response;
}

export function setMapCache(key: string, response: string): void {
  db.prepare(`INSERT INTO map_cache (query_hash, response, created_at) VALUES (?, ?, ?)
    ON CONFLICT(query_hash) DO UPDATE SET response = excluded.response, created_at = excluded.created_at`)
    .run(key, response, new Date().toISOString());
}
