// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, firefox, webkit } from 'playwright';
import { build, type Plugin, type PreviewServer, preview } from 'vite';
import { lockedWheels } from '../../../../packages/adapter-pyodide/src/runtime-files.js';
import { adkPythonSources } from '../../../../tests/conformance/support/adk-python-sources.node.js';
import { cspHeader } from '../../src/host/csp.js';

type AdkEngine = 'chromium' | 'firefox' | 'webkit';
const engines = { chromium, firefox, webkit };
export function selectAdkEngine(value = 'chromium'): AdkEngine {
  if (value !== 'chromium' && value !== 'firefox' && value !== 'webkit')
    throw new Error(`GALAXIE_BROWSER must be one of chromium, firefox, webkit, not "${value}".`);
  return value;
}
export const adkEngine: AdkEngine = selectAdkEngine(process.env['GALAXIE_BROWSER']);
export const adkHeader: string = cspHeader('mock');
export function launchAdkEngine(): Promise<Browser> {
  return engines[adkEngine].launch({ headless: true });
}

export async function buildAdkPythonPage(names: readonly string[]): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-adk-engine-'));
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
    const root = fileURLToPath(new URL('./adk-python-conformance/', import.meta.url));
    const configFile = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));
    const outDir = join(directory, 'dist');
    const local = JSON.parse(
      await readFile(
        new URL('../../../../.cache/python-wheels/local-wheels.json', import.meta.url),
        'utf8',
      ),
    );
    const sources = await Promise.all(
      names.map(async (name) => ({
        name,
        files: await adkPythonSources(name),
      })),
    );
    const extraWheels = await Promise.all(
      lockedWheels
        .filter(
          (wheel) => wheel.frameworks?.includes('adk') && !wheel.frameworks.includes('langgraph'),
        )
        .map(async (wheel) => ({
          file: wheel.file,
          source: await readFile(
            new URL(`../../../../.cache/python-wheels/${wheel.file}`, import.meta.url),
          ),
        })),
    );
    const previous = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      await build({
        configFile,
        root,
        mode: 'mock',
        publicDir: false,
        logLevel: 'silent',
        define: { PYTHON_LOCAL_WHEELS: JSON.stringify(local.packages) },
        plugins: [
          {
            name: 'adk-python-conformance-assets',
            generateBundle() {
              for (const { name, files } of sources)
                for (const [file, source] of Object.entries(files))
                  this.emitFile({
                    type: 'asset',
                    fileName: `conformance/${name}/${file}`,
                    source,
                  });
              for (const { file, source } of extraWheels)
                this.emitFile({ type: 'asset', fileName: `python/wheels/${file}`, source });
            },
          },
        ],
        build: {
          outDir,
          emptyOutDir: true,
          rolldownOptions: { input: join(root, 'index.html') },
        },
      });
    } finally {
      if (previous === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previous;
    }
    server = await preview({
      configFile,
      root,
      mode: 'mock',
      logLevel: 'silent',
      build: { outDir },
      plugins: [
        {
          name: 'adk-engine-csp',
          configurePreviewServer(server): void {
            // Apply CSP before Vite's conditional-response shortcut.
            server.middlewares.use((_request, response, next) => {
              response.setHeader('Content-Security-Policy', adkHeader);
              next();
            });
          },
        } satisfies Plugin,
      ],
      preview: {
        host: '127.0.0.1',
        port: 0,
        strictPort: true,
        headers: { 'Content-Security-Policy': adkHeader },
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
