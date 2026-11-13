// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, firefox, webkit } from 'playwright';
import { build, type Plugin, preview } from 'vite';
import { cspHeader } from '../../src/host/csp.js';
import type { Script } from './adk-go-engine/run.js';
import type { Reference } from './adk-go-reference.node.js';

const engines = { chromium, firefox, webkit };
type Engine = 'chromium' | 'firefox' | 'webkit';
export function selectAdkGoEngine(value = 'chromium'): Engine {
  if (value !== 'chromium' && value !== 'firefox' && value !== 'webkit')
    throw new Error(`GALAXIE_BROWSER must be one of chromium, firefox, webkit, not "${value}".`);
  return value;
}
export const adkGoEngine: Engine = selectAdkGoEngine(process.env['GALAXIE_BROWSER']);
export function launchAdkGoEngine(): Promise<Browser> {
  return engines[adkGoEngine].launch({ headless: true });
}

export async function buildAdkGoEnginePage(
  reference: Reference,
  scripts: Readonly<Record<string, Script>>,
  wasmAllowed: boolean,
): Promise<{ origin: string; header: string; close(): Promise<void> }> {
  const root = fileURLToPath(new URL('./adk-go-engine/', import.meta.url));
  const publicDir = join(reference.directory, 'engine-public');
  await mkdir(publicDir, { recursive: true });
  await copyFile(reference.file, join(publicDir, 'reference.wasm'));
  const outDir = join(reference.directory, wasmAllowed ? 'engine-dist' : 'engine-negative');
  await build({
    configFile: false,
    root,
    publicDir,
    logLevel: 'silent',
    define: {
      REFERENCE_WASM: JSON.stringify(reference.wasm),
      REFERENCE_SCRIPTS: JSON.stringify(scripts),
    },
    resolve: {
      alias: {
        '@galaxie-ai/storage-indexeddb': fileURLToPath(
          new URL('../../../../packages/storage-indexeddb/src/index.ts', import.meta.url),
        ),
      },
    },
    worker: { format: 'es' },
    build: { outDir, emptyOutDir: true },
  });
  const header = wasmAllowed
    ? cspHeader('mock')
    : cspHeader('mock').replace(" 'wasm-unsafe-eval'", '');
  const server = await preview({
    configFile: false,
    root,
    logLevel: 'silent',
    build: { outDir },
    plugins: [
      {
        name: 'adk-go-engine-csp',
        configurePreviewServer(server): void {
          // Apply CSP before Vite's conditional-response shortcut.
          server.middlewares.use((_request, response, next) => {
            response.setHeader('Content-Security-Policy', header);
            next();
          });
        },
      } satisfies Plugin,
    ],
    preview: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      headers: { 'Content-Security-Policy': header },
    },
  });
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => (error ? reject(error) : resolve()));
      if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
    });
  };
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') {
    await close();
    throw new Error('The preview has no port.');
  }
  return { origin: `http://127.0.0.1:${address.port}`, header, close };
}
