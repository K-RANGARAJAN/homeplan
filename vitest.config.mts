import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest needs to be told about the `@/` path alias from tsconfig.json. Next.js resolves it in the
 * app, but a plain Node test run has no idea what `@/lib/...` means, and the failure looks like a
 * missing package rather than a missing config.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
});
