// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfigExport } from 'vite';
import { cspMeta } from './scripts/csp-meta.js';
import { pythonAssets } from './scripts/python-assets.js';
import { cspHeader } from './src/host/csp.js';

// A project-site host such as GitHub Pages serves the build under a path prefix. Set
// GALAXIE_DEMO_BASE (for example '/galaxie/') at build time; the default keeps root paths.
const config: UserConfigExport = defineConfig(({ mode }) => {
  const base = process.env['GALAXIE_DEMO_BASE'] ?? '/';
  return {
    base,
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [pythonAssets(), ...(mode === 'mock' ? [cspMeta(mode)] : [])],
    resolve: {
      alias: {
        '@galaxie-ai/storage-indexeddb': fileURLToPath(
          new URL('../../packages/storage-indexeddb/src/index.ts', import.meta.url),
        ),
        '@galaxie-ai/adapter-pyodide/worker': fileURLToPath(
          new URL('../../packages/adapter-pyodide/src/worker.ts', import.meta.url),
        ),
        '@galaxie-ai/adapter-pyodide': fileURLToPath(
          new URL('../../packages/adapter-pyodide/src/index.ts', import.meta.url),
        ),
        '@galaxie-ai/react': fileURLToPath(
          new URL('../../packages/react/src/index.ts', import.meta.url),
        ),
        '@galaxie-ai/models/builtin-ai': fileURLToPath(
          new URL('../../packages/models/src/builtin-ai/index.ts', import.meta.url),
        ),
        '@galaxie-ai/models/webllm/worker': fileURLToPath(
          new URL('../../packages/models/src/webllm/worker.ts', import.meta.url),
        ),
        '@galaxie-ai/models/webllm': fileURLToPath(
          new URL('../../packages/models/src/webllm/index.ts', import.meta.url),
        ),
        '@galaxie-ai/models/mock': fileURLToPath(
          new URL('../../packages/models/src/mock.ts', import.meta.url),
        ),
        '@galaxie-ai/adapter-kit': fileURLToPath(
          new URL('../../packages/adapter-kit/src/index.ts', import.meta.url),
        ),
        '@galaxie-ai/core/browser': fileURLToPath(
          new URL('../../packages/core/src/browser.ts', import.meta.url),
        ),
        '@galaxie-ai/core': fileURLToPath(
          new URL('../../packages/core/src/index.ts', import.meta.url),
        ),
        '@galaxie-ai/adapter-langgraph': fileURLToPath(
          new URL('../../packages/adapter-langgraph/src/index.ts', import.meta.url),
        ),
      },
    },
    worker: {
      format: 'es',
      rolldownOptions: {
        external: ['pyodide'],
        output: { paths: { pyodide: `${base}python/runtime/pyodide.mjs` } },
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
  };
});

export default config;
