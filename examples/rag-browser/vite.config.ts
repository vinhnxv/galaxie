// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfigExport } from 'vite';
import { cspMeta } from './scripts/csp-meta.js';
import { pythonAssets } from './scripts/python-assets.js';
import { cspHeader } from './src/host/csp.js';

const config: UserConfigExport = defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [pythonAssets(), ...(mode === 'mock' ? [cspMeta(mode)] : [])],
  resolve: {
    alias: {
      '@galaxie/storage-indexeddb': fileURLToPath(
        new URL('../../packages/storage-indexeddb/src/index.ts', import.meta.url),
      ),
      '@galaxie/adapter-pyodide/worker': fileURLToPath(
        new URL('../../packages/adapter-pyodide/src/worker.ts', import.meta.url),
      ),
      '@galaxie/adapter-pyodide': fileURLToPath(
        new URL('../../packages/adapter-pyodide/src/index.ts', import.meta.url),
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
      '@galaxie/adapter-kit': fileURLToPath(
        new URL('../../packages/adapter-kit/src/index.ts', import.meta.url),
      ),
      '@galaxie/core/browser': fileURLToPath(
        new URL('../../packages/core/src/browser.ts', import.meta.url),
      ),
      '@galaxie/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@galaxie/adapter-langgraph': fileURLToPath(
        new URL('../../packages/adapter-langgraph/src/index.ts', import.meta.url),
      ),
    },
  },
  worker: {
    format: 'es',
    rolldownOptions: {
      external: ['pyodide'],
      output: { paths: { pyodide: '/python/runtime/pyodide.mjs' } },
    },
  },
  optimizeDeps: { exclude: ['@huggingface/transformers', 'onnxruntime-web', '@mlc-ai/web-llm'] },
  build: {
    rolldownOptions: {
      preserveEntrySignatures: 'strict',
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        host: fileURLToPath(new URL('./src/host/main.tsx', import.meta.url)),
      },
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
  server: { headers: { 'Content-Security-Policy': cspHeader(mode) } },
  preview: { headers: { 'Content-Security-Policy': cspHeader(mode) } },
}));

export default config;
