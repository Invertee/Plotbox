import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
    maxWorkers: 1,
    minWorkers: 1,
    include: ['tests/**/*.test.ts'],
  },
});
