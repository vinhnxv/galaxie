// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfigExport } from 'vite';
import { cspHeader } from './src/host/csp.js';
import { goAssets, goWorkerGlue } from './src/host/go-assets.js';
import { pythonAssets } from './src/host/python-assets.js';

const config: UserConfigExport = defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [pythonAssets(), goAssets()],
  define: { 'process.env.ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS': '"false"' },
  resolve: {
    alias: [
      {
        find: /^@google\/adk$/,
        replacement: fileURLToPath(
          new URL(
            '../../packages/adapter-adk/node_modules/@google/adk/dist/web/index_web.js',
            import.meta.url,
          ),
        ),
      },
      ...Object.entries({
        '@galaxie/react': fileURLToPath(
          new URL('../../packages/react/src/index.ts', import.meta.url),
        ),
        '@galaxie/storage-indexeddb': fileURLToPath(
          new URL('../../packages/storage-indexeddb/src/index.ts', import.meta.url),
        ),
        '@galaxie/adapter-go/worker': fileURLToPath(
          new URL('../../packages/adapter-go/src/worker.ts', import.meta.url),
        ),
        '@galaxie/core': fileURLToPath(
          new URL('../../packages/core/src/index.ts', import.meta.url),
        ),
        '@galaxie/adapter-adk': fileURLToPath(
          new URL('../../packages/adapter-adk/src/index.ts', import.meta.url),
        ),
        '@galaxie/adapter-go': fileURLToPath(
          new URL('../../packages/adapter-go/src/index.ts', import.meta.url),
        ),
        '@galaxie/models/mock': fileURLToPath(
          new URL('../../packages/models/src/mock.ts', import.meta.url),
        ),
        '@galaxie/adapter-pyodide/worker': fileURLToPath(
          new URL('../../packages/adapter-pyodide/src/worker.ts', import.meta.url),
        ),
        '@galaxie/adapter-pyodide': fileURLToPath(
          new URL('../../packages/adapter-pyodide/src/index.ts', import.meta.url),
        ),
      }).map(([find, replacement]) => ({ find, replacement })),
    ],
  },
  worker: {
    plugins: () => [goWorkerGlue()],
    format: 'es',
    rolldownOptions: {
      external: ['pyodide'],
      output: { paths: { pyodide: '/python/runtime/pyodide.mjs' } },
    },
  },
  server: { headers: { 'Content-Security-Policy': cspHeader() } },
  preview: { headers: { 'Content-Security-Policy': cspHeader() } },
});

export default config;
