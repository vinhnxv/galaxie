// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, firefox, webkit } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { cspHeader } from '../../src/host/csp.js';

type DspyEngine = 'chromium' | 'firefox' | 'webkit';
const engines = { chromium, firefox, webkit };
export function selectDspyEngine(value = 'chromium'): DspyEngine {
  if (value !== 'chromium' && value !== 'firefox' && value !== 'webkit')
    throw new Error(`GALAXIE_BROWSER must be one of chromium, firefox, webkit, not "${value}".`);
  return value;
}
export const dspyEngine: DspyEngine = selectDspyEngine(process.env['GALAXIE_BROWSER']);
export const dspyHeader: string = cspHeader('mock');

export function launchDspyEngine(): Promise<Browser> {
  return engines[dspyEngine].launch({ headless: true });
}

/** Build the existing strict-CSP fixture pages with locally served runtime and wheels. */
export async function buildDspyPage(
  root: URL,
  cases: Readonly<Record<string, Record<string, string>>>,
): Promise<{ origin: string; close(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-dspy-engine-'));
  let server: PreviewServer | undefined;
  const close = async (): Promise<void> => {
    if (server) {
      const current = server;
      await new Promise<void>((resolve, reject) => {
        current.httpServer.close((error) => (error ? reject(error) : resolve()));
        if ('closeAllConnections' in current.httpServer) current.httpServer.closeAllConnections();
      });
    }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const publicDir = join(directory, 'public');
    await mkdir(join(publicDir, 'python'), { recursive: true });
    await cp(
      fileURLToPath(
        new URL('../../../../packages/adapter-pyodide/node_modules/pyodide/', import.meta.url),
      ),
      join(publicDir, 'python/runtime'),
      { recursive: true, dereference: true },
    );
    await cp(
      fileURLToPath(new URL('../../../../.cache/python-wheels/', import.meta.url)),
      join(publicDir, 'python/wheels'),
      { recursive: true },
    );
    for (const [name, sources] of Object.entries(cases)) {
      const path = join(publicDir, 'conformance', name);
      await mkdir(path, { recursive: true });
      for (const [file, source] of Object.entries(sources))
        await writeFile(join(path, file), source);
    }
    const local = JSON.parse(
      await readFile(
        new URL('../../../../.cache/python-wheels/local-wheels.json', import.meta.url),
        'utf8',
      ),
    );
    const configFile = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));
    const outDir = join(directory, 'dist');
    const pageRoot = fileURLToPath(root);
    const previous = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      await build({
        configFile,
        root: pageRoot,
        mode: 'mock',
        publicDir,
        logLevel: 'silent',
        define: { PYTHON_LOCAL_WHEELS: JSON.stringify(local.packages) },
        build: {
          outDir,
          emptyOutDir: true,
          rolldownOptions: { input: join(pageRoot, 'index.html') },
        },
      });
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
    server = await preview({
      configFile,
      root: pageRoot,
      mode: 'mock',
      logLevel: 'silent',
      build: { outDir },
      preview: {
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
        headers: { 'Content-Security-Policy': dspyHeader },
      },
    });
    const address = server.httpServer.address();
    if (!address || typeof address === 'string')
      throw new Error('The conformance preview has no port.');
    return { origin: `http://127.0.0.1:${address.port}`, close };
  } catch (error) {
    await close();
    throw error;
  }
}
