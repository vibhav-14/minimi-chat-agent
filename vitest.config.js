import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only this project's tests: tool folders next to the source may hold copies of the repo.
    include: ['src/**/*.test.ts'],
  },
});
