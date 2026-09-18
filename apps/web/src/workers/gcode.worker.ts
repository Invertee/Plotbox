/// <reference lib="webworker" />
import type { GCodeSettings, PenProfile, PlotGeometry, PlotPass } from '@plotter/core';
import { generateGCode } from '@plotter/gcode';

type GCodeJob = {
  jobId: number;
  projectName: string;
  geometry: PlotGeometry;
  passes: PlotPass[];
  pens: PenProfile[];
  settings: GCodeSettings;
  pageHeight: number;
  split: boolean;
  visibleLayerIds: string[];
};

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<GCodeJob>) => {
  const job = event.data;
  try {
    const visibleLayers = new Set(job.visibleLayerIds);
    const geometry = { ...job.geometry, paths: job.geometry.paths.filter((path) => visibleLayers.has(path.layerId)) };
    scope.postMessage({ type: 'progress', jobId: job.jobId, value: 0.03, message: `Preparing ${geometry.paths.length.toLocaleString()} paths` });
    const documents = generateGCode(job.projectName, geometry, job.passes, job.pens, job.settings, job.pageHeight, job.split, (value, message) => {
      scope.postMessage({ type: 'progress', jobId: job.jobId, value, message });
    });
    scope.postMessage({ type: 'complete', jobId: job.jobId, documents });
  } catch (error) {
    scope.postMessage({ type: 'error', jobId: job.jobId, message: error instanceof Error ? error.message : 'G-code generation failed.' });
  }
};
