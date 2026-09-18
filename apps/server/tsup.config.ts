import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  splitting: false,
  // Workspace packages are symlinked by npm and are not available in the
  // minimal runtime image, so include this one in the server artifact.
  noExternal: ['@plotter/core'],
});
