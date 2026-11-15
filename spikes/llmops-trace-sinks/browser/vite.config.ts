// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig, type PreviewServer, preview } from 'vite';
import type { ScoreEndpoint } from '../src/score-endpoint.js';
import { shared, singleCopy } from '../src/single-copy.js';

export const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";
export const pageConfig: InlineConfig = {
  configFile: false,
  root: fileURLToPath(new URL('./', import.meta.url)),
  resolve: { dedupe: shared },
  plugins: [singleCopy()],
  build: {
    outDir: fileURLToPath(new URL('../dist/page/', import.meta.url)),
    emptyOutDir: true,
    minify: true,
  },
  preview: {
    host: '127.0.0.1',
    strictPort: true,
    headers: { 'Content-Security-Policy': csp },
    proxy: { '/otel/v1/traces': { target: 'http://127.0.0.1:4318', rewrite: () => '/v1/traces' } },
  },
};

export async function buildPage(): Promise<Record<string, number>> {
  const copies = Object.fromEntries(shared.map((name) => [name, new Set<string>()]));
  await build({
    ...pageConfig,
    plugins: [
      ...(pageConfig.plugins ?? []),
      {
        name: 'measure-shared-copies',
        generateBundle() {
          for (const id of this.getModuleIds())
            for (const name of shared) {
              const marker = `/node_modules/${name}/`;
              const index = id.lastIndexOf(marker);
              if (index !== -1) copies[name]?.add(id.slice(0, index + marker.length));
            }
        },
      },
    ],
  });
  return Object.fromEntries(Object.entries(copies).map(([name, paths]) => [name, paths.size]));
}

export async function startPreview(endpoint?: ScoreEndpoint): Promise<PreviewServer> {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('No preview port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
  return preview({
    ...pageConfig,
    plugins: [
      ...(pageConfig.plugins ?? []),
      ...(endpoint
        ? [
            {
              name: 'host-feedback-scores',
              configurePreviewServer(server: PreviewServer) {
                server.middlewares.use((request, response, next) => {
                  if (request.url?.split('?')[0] !== '/feedback/scores') {
                    next();
                    return;
                  }
                  endpoint.handle(request, response).catch(() => {
                    if (!response.headersSent) response.writeHead(500);
                    response.end();
                  });
                });
              },
            },
          ]
        : []),
    ],
    preview: { ...pageConfig.preview, port },
  });
}

export default pageConfig;
