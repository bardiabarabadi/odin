import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'webview/test/**/*.test.ts'],
    environment: 'node',
  },
});
