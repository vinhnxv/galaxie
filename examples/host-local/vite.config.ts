// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfigExport } from 'vite';
import { cspHeader } from './src/csp.js';

const config: UserConfigExport = defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@galaxie/example-english-tutor': fileURLToPath(
        new URL('../../examples/english-tutor/src/index.ts', import.meta.url),
      ),
      '@galaxie/react': fileURLToPath(
        new URL('../../packages/react/src/index.ts', import.meta.url),
      ),
      '@galaxie/models/builtin-ai': fileURLToPath(
        new URL('../../packages/models/src/builtin-ai/index.ts', import.meta.url),
      ),
      '@galaxie/models/webllm/worker': fileURLToPath(
        new URL('../../packages/models/src/webllm/worker.ts', import.meta.url),
      ),
      '@galaxie/models/webllm': fileURLToPath(
        new URL('../../packages/models/src/webllm/index.ts', import.meta.url),
      ),
      '@galaxie/models/mock': fileURLToPath(
        new URL('../../packages/models/src/mock.ts', import.meta.url),
      ),
      '@galaxie/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@galaxie/adapter-langgraph': fileURLToPath(
        new URL('../../packages/adapter-langgraph/src/index.ts', import.meta.url),
      ),
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  server: { headers: { 'Content-Security-Policy': cspHeader(mode) } },
  preview: { headers: { 'Content-Security-Policy': cspHeader(mode) } },
}));

export default config;
