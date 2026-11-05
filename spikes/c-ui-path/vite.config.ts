// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const packages = ['@langchain/core', '@langchain/langgraph', '@langchain/langgraph-checkpoint'];

function singleCopy(): Plugin {
  const resolutions = new Map<string, string>();
  const allowed = realpathSync(`${root}node_modules`);
  return {
    name: 'spike-c-single-copy',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!packages.some((name) => source === name || source.startsWith(`${name}/`))) return;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved === null) throw new Error(`Unresolved LangChain import: ${source}`);
      // Scans mark bare imports external; optimized URLs are generated after this hook.
      // Their physical imports are checked by the same plugin in the optimizer.
      if (resolved.external || resolved.id.startsWith(`${root}node_modules/.vite/`))
        return resolved;
      const path = realpathSync(resolved.id.split('?')[0] ?? resolved.id);
      if (!path.startsWith(`${allowed}/`)) {
        throw new Error(`LangChain resolved outside the spike: ${source}: ${path}`);
      }
      resolutions.set(`${source} from ${importer ?? 'entry'}`, path);
      return resolved;
    },
    configureServer(server) {
      server.middlewares.use('/__single-copy', (_request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ok: resolutions.size > 0, resolutions: [...resolutions] }));
      });
    },
    buildEnd(error) {
      if (!error && resolutions.size === 0) throw new Error('No LangChain imports were checked.');
    },
  };
}

const audit = singleCopy();

export default defineConfig({
  root,
  plugins: [audit, react()],
  resolve: {
    alias: {
      '@galaxie/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
      '@galaxie/adapter-langgraph': fileURLToPath(
        new URL('../../packages/adapter-langgraph/src/index.ts', import.meta.url),
      ),
    },
    dedupe: [...packages, 'zod', '@opentelemetry/api'],
  },
  server: { host: '127.0.0.1', port: 4176, strictPort: true },
  optimizeDeps: {
    force: true,
    rolldownOptions: { plugins: [audit] },
    include: [
      '@langchain/langgraph/web',
      '@langchain/core/callbacks/base',
      '@langchain/core/language_models/chat_models',
      '@langchain/core/messages',
      '@langchain/core/outputs',
      '@langchain/core/singletons',
      '@opentelemetry/api',
      'zod',
      'react',
      'react-dom/client',
      'react/jsx-dev-runtime',
    ],
  },
});
