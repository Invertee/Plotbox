import { useState } from "react";

import type { ProjectRecipe } from "./types";

interface ProjectListProps {
  projects: ProjectRecipe[];
  activeProjectId: string | null;
  connected: boolean;
  busy: boolean;
  onCreate: (name: string, pagePreset: "A3" | "A4", orientation: "landscape" | "portrait") => void;
  onOpen: (projectId: string) => void;
  onRename: (projectId: string, name: string) => void;
  onDelete: (projectId: string) => void;
}

export function ProjectList({
  projects,
  activeProjectId,
  connected,
  busy,
  onCreate,
  onOpen,
  onRename,
  onDelete,
}: ProjectListProps) {
  const [newName, setNewName] = useState("A3 two-pass test");
  const [pagePreset, setPagePreset] = useState<"A3" | "A4">("A3");
  const [orientation, setOrientation] = useState<"landscape" | "portrait">("landscape");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  return (
    <section className="projects-page" aria-labelledby="projects-heading">
      <div className="projects-hero">
        <div>
          <p className="eyebrow">FILESYSTEM PROJECTS</p>
          <h2 id="projects-heading">Your plotter projects</h2>
          <p>Create artwork, reopen saved recipes, or tidy up projects you no longer need.</p>
        </div>
        <form
          className="new-project-form"
          onSubmit={(event) => {
            event.preventDefault();
            const name = newName.trim();
            if (name) onCreate(name, pagePreset, orientation);
          }}
        >
          <label>
            Project name
            <input
              value={newName}
              minLength={1}
              maxLength={120}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <label>
            Page size
            <select
              aria-label="New project page size"
              value={pagePreset}
              onChange={(event) => setPagePreset(event.target.value as "A3" | "A4")}
            >
              <option value="A3">A3</option>
              <option value="A4">A4</option>
            </select>
          </label>
          <label>
            Orientation
            <select
              aria-label="New project orientation"
              value={orientation}
              onChange={(event) => setOrientation(event.target.value as "landscape" | "portrait")}
            >
              <option value="landscape">Landscape</option>
              <option value="portrait">Portrait</option>
            </select>
          </label>
          <button className="primary-button" type="submit" disabled={!connected || busy}>
            Create {pagePreset} project
          </button>
        </form>
      </div>

      {projects.length === 0 ? (
        <div className="empty-projects">
          <strong>No projects yet</strong>
          <span>Your first project will be stored as an ordinary directory.</span>
        </div>
      ) : (
        <div className="project-grid">
          {projects.map((item) => {
            const editing = editingId === item.project_id;
            const deleting = deletingId === item.project_id;
            return (
              <article className="project-card" key={item.project_id}>
                <div className="project-card-heading">
                  <div>
                    <small>{item.mode.mode_id.replace(/^builtin\./, "")}</small>
                    <h3>{item.name}</h3>
                  </div>
                  {activeProjectId === item.project_id && <span className="active-pill">Open</span>}
                </div>
                <dl>
                  <div>
                    <dt>Revision</dt>
                    <dd>{item.revision}</dd>
                  </div>
                  <div>
                    <dt>Page</dt>
                    <dd>
                      {item.page.width_mm} × {item.page.height_mm} mm
                    </dd>
                  </div>
                  <div>
                    <dt>Seed</dt>
                    <dd>{item.mode.seed}</dd>
                  </div>
                </dl>

                {editing ? (
                  <form
                    className="project-inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const name = editingName.trim();
                      if (!name) return;
                      onRename(item.project_id, name);
                      setEditingId(null);
                    }}
                  >
                    <label>
                      Rename project
                      <input
                        autoFocus
                        value={editingName}
                        maxLength={120}
                        onChange={(event) => setEditingName(event.target.value)}
                      />
                    </label>
                    <div className="action-row">
                      <button type="submit" disabled={busy || !editingName.trim()}>
                        Save name
                      </button>
                      <button type="button" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </form>
                ) : deleting ? (
                  <div className="delete-confirmation" role="alert">
                    <strong>Delete “{item.name}” permanently?</strong>
                    <span>This removes its sources, caches, and exports from local storage.</span>
                    <div className="action-row">
                      <button
                        className="danger-button"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onDelete(item.project_id);
                          setDeletingId(null);
                        }}
                      >
                        Confirm delete
                      </button>
                      <button type="button" onClick={() => setDeletingId(null)}>
                        Keep project
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="project-card-actions">
                    <button
                      className="primary-button"
                      type="button"
                      disabled={busy}
                      onClick={() => onOpen(item.project_id)}
                    >
                      Open project
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditingId(item.project_id);
                        setEditingName(item.name);
                        setDeletingId(null);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="danger-link"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setDeletingId(item.project_id);
                        setEditingId(null);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
