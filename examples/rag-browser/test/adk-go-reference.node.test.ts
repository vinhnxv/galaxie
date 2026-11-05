// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { afterAll, expect, test } from 'vitest';
import { readGolden, readScripts } from '../../../tests/conformance/support/adk-go.node.js';
import { cspHeader } from '../src/host/csp.js';
import { comparable, type Observed } from './support/adk-go-ref/run.js';
import {
  buildReference,
  disposeReference,
  type Reference,
} from './support/adk-go-reference.node.js';
import { goAvailable, maxColdStartMs, maxWasmBytes, missingGo } from './support/go-gate.node.js';

const pageRoot = fileURLToPath(new URL('./support/adk-go-ref/', import.meta.url));

interface PageState {
  results: Record<string, Observed>;
  durable: Record<string, Observed>;
  errors: Record<string, string>;
  violations: string[];
  done: boolean;
}

afterAll(disposeReference);

/** Serves the built page with the strict mock-mode CSP, optionally without wasm compilation. */
async function runInChromium(
  reference: Reference,
  wasmAllowed: boolean,
): Promise<{ state: PageState; external: string[] }> {
  const scripts = await readScripts();
  const publicDir = join(reference.directory, 'public');
  await mkdir(publicDir, { recursive: true });
  await copyFile(reference.file, join(publicDir, 'reference.wasm'));
  const outDir = join(reference.directory, wasmAllowed ? 'dist' : 'dist-negative');
  await build({
    configFile: false,
    root: pageRoot,
    publicDir,
    logLevel: 'silent',
    define: {
      REFERENCE_WASM: JSON.stringify(reference.wasm),
      REFERENCE_SCRIPTS: JSON.stringify(scripts),
    },
    // The page reads the storage package from source, so the lane never depends on a stale build.
    resolve: {
      alias: {
        '@galaxie/storage-indexeddb': fileURLToPath(
          new URL('../../../packages/storage-indexeddb/src/index.ts', import.meta.url),
        ),
      },
    },
    worker: { format: 'es' },
    build: { outDir, emptyOutDir: true },
  });
  const csp = wasmAllowed
    ? cspHeader('mock')
    : cspHeader('mock').replace(" 'wasm-unsafe-eval'", '');
  if (wasmAllowed) expect(csp).toContain("'wasm-unsafe-eval'");
  else expect(csp).not.toContain('wasm-unsafe-eval');
  const server = await preview({
    configFile: false,
    root: pageRoot,
    logLevel: 'silent',
    build: { outDir },
    preview: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      headers: { 'Content-Security-Policy': csp },
    },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('The preview has no port.');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const external: string[] = [];
    await context.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      external.push(route.request().url());
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.waitForFunction(() => Reflect.get(globalThis, 'adkGo')?.done === true, undefined, {
      timeout: 180000,
    });
    const state = (await page.evaluate(() => Reflect.get(globalThis, 'adkGo'))) as PageState;
    return { state, external };
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => (error ? reject(error) : resolve()));
      if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
    });
  }
}

test.skipIf(!goAvailable)(
  goAvailable ? 'Chromium reproduces every native golden under the strict CSP' : missingGo,
  async () => {
    const reference = await buildReference();
    const { state, external } = await runInChromium(reference, true);
    expect(state.errors).toEqual({});
    expect(state.violations).toEqual([]);
    expect(external).toEqual([]);
    const scripts = await readScripts();
    for (const name of Object.keys(scripts)) {
      expect(comparable(state.results[name] as Observed), name).toEqual(await readGolden(name));
      expect((state.results[name] as Observed).streams, name).toEqual(scripts[name]?.streams ?? []);
    }
    // The pausing cases again, with IndexedDB reopened and a new Worker at every pause.
    const pausing = Object.keys(scripts).filter(
      (name) => (scripts[name]?.answers?.length ?? 0) > 0,
    );
    expect(Object.keys(state.durable).sort()).toEqual([...pausing].sort());
    for (const name of pausing) {
      expect(comparable(state.durable[name] as Observed), `durable ${name}`).toEqual(
        await readGolden(name),
      );
      expect((state.durable[name] as Observed).streams, `durable ${name}`).toEqual(
        scripts[name]?.streams ?? [],
      );
    }
    const coldStartMs = Math.max(...Object.values(state.results).map((r) => r.coldStartMs ?? -1));
    const wasmBytes = (await readFile(reference.file)).byteLength;
    console.info(`adk-go chromium ${JSON.stringify({ wasmBytes, coldStartMs })}`);
    expect(wasmBytes).toBeLessThanOrEqual(maxWasmBytes);
    expect(coldStartMs).toBeLessThanOrEqual(maxColdStartMs);
  },
  300000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'the reference fails without wasm-unsafe-eval, so the directive is needed'
    : missingGo,
  async () => {
    const reference = await buildReference();
    const { state } = await runInChromium(reference, false);
    const results = Object.values(state.results);
    expect(results.length + Object.keys(state.errors).length).toBeGreaterThan(0);
    for (const result of results) expect(result.output).toBe('');
    expect(
      Object.keys(state.errors).length + results.filter((r) => r.error).length,
    ).toBeGreaterThan(0);
  },
  300000,
);
