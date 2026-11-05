// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { buildGoWasm } from '../../../../scripts/build-go-wasm.ts';
import { fetchGoGlue } from '../../../../scripts/fetch-go-glue.ts';
import type { Reference } from '../../../rag-browser/test/support/adk-go-reference.node.js';

/** Mirrors the reference module's Worker host, with the recipe's own wasm entry. */
export async function buildFinancialGo(): Promise<Reference> {
  await fetchGoGlue();
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-financial-go-'));
  try {
    const file = join(directory, 'financial.wasm');
    const module = await buildGoWasm('./recipes/financial/main', file);
    const bundle = join(directory, 'node-bundle');
    const workerRoot = fileURLToPath(
      new URL('../../../rag-browser/test/support/go-gate/', import.meta.url),
    );
    await build({
      configFile: false,
      root: workerRoot,
      logLevel: 'silent',
      build: {
        ssr: join(workerRoot, 'adapter-worker.ts'),
        outDir: bundle,
        emptyOutDir: true,
        rolldownOptions: {
          output: { entryFileNames: 'worker.mjs', chunkFileNames: '[name]-[hash].mjs' },
        },
      },
    });
    await writeFile(
      join(bundle, 'bootstrap.mjs'),
      `import { parentPort, workerData } from 'node:worker_threads';
globalThis.location = new URL(workerData.origin);
globalThis.postMessage = (message) => parentPort.postMessage(message);
globalThis.addEventListener = (type, listener) => {
  if (type === 'message') parentPort.on('message', (data) => listener({ data }));
};
await import('./worker.mjs');
`,
    );
    return {
      directory,
      file,
      bundle,
      wasm: { url: '/financial.wasm', sha256: module.sha256, bytes: module.bytes },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
