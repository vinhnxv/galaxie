// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfigExport } from 'vite';
import { backend } from './server/backend.js';
import { cspHeader } from './src/csp.js';

const config: UserConfigExport = defineConfig({
  plugins: [backend()],
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
      '@galaxie/models/openai': fileURLToPath(
        new URL('../../packages/models/src/openai/index.ts', import.meta.url),
      ),
      '@galaxie/models/mock': fileURLToPath(
        new URL('../../packages/models/src/mock.ts', import.meta.url),
      ),
      '@galaxie/adapter-kit': fileURLToPath(
        new URL('../../packages/adapter-kit/src/index.ts', import.meta.url),
      ),
      '@galaxie/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@galaxie/adapter-langgraph': fileURLToPath(
        new URL('../../packages/adapter-langgraph/src/index.ts', import.meta.url),
      ),
    },
  },
  build: {
    rolldownOptions: {
      preserveEntrySignatures: 'strict',
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        host: fileURLToPath(new URL('./src/main.tsx', import.meta.url)),
      },
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  server: { host: '127.0.0.1', headers: { 'Content-Security-Policy': cspHeader() } },
  preview: { host: '127.0.0.1', headers: { 'Content-Security-Policy': cspHeader() } },
});

export default config;
