import { create } from 'zustand';
import type { PlotGeometry, Project, ProjectState } from '@plotter/core';

type EditorStore = {
  project?: Project;
  dirty: boolean;
  setProject: (project?: Project) => void;
  updateState: (update: Partial<ProjectState> | ((state: ProjectState) => ProjectState)) => void;
  updateName: (name: string) => void;
  setGeometry: (geometry: PlotGeometry) => void;
  markSaved: (project?: Project) => void;
};

export const useEditorStore = create<EditorStore>((set) => ({
  dirty: false,
  setProject: (project) => set({ project, dirty: false }),
  updateState: (update) => set((current) => {
    if (!current.project) return current;
    const state = typeof update === 'function' ? update(current.project.state) : { ...current.project.state, ...update };
    return { project: { ...current.project, state }, dirty: true };
  }),
  updateName: (name) => set((current) => current.project ? ({ project: { ...current.project, name }, dirty: true }) : current),
  setGeometry: (geometry) => set((current) => current.project ? ({ project: { ...current.project, state: { ...current.project.state, geometry } }, dirty: true }) : current),
  markSaved: (project) => set((current) => ({ project: project ?? current.project, dirty: false })),
}));
