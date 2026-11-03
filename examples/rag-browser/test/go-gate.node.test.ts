// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { afterAll, expect, test } from 'vitest';
import { cspHeader } from '../src/host/csp.js';
import {
  buildGate,
  gateRoot,
  goAvailable,
  maxColdStartMs,
  maxWasmBytes,
  missingGo,
} from './support/go-gate.node.js';

interface Report {
  scenarios: Record<string, unknown>;
  egress: unknown;
  egressAttempts: number;
  timings: { fetchMs: number; compileMs: number; startMs: number };
  violations: string[];
  compileProbe: string | null;
  error?: string;
}
interface PageState {
  report?: Report;
  adapter?: { coldStartMs: number; wallMs: number; disposed: boolean };
  adapterError?: string;
  error?: string;
  violations: string[];
}

afterAll(async () => {
  if (goAvailable) await rm((await buildGate()).directory, { recursive: true, force: true });
});

/** Serves the built page with the strict mock-mode CSP, optionally without wasm compilation. */
async function runInChromium(wasmAllowed: boolean): Promise<{
  state: PageState;
  external: string[];
  wasmBytes: number;
}> {
  const gate = await buildGate();
  const outDir = join(gate.directory, wasmAllowed ? 'dist' : 'dist-negative');
  await build({
    configFile: false,
    root: gateRoot,
    publicDir: join(gate.directory, 'public'),
    logLevel: 'silent',
    define: { GO_GATE_WASM: JSON.stringify(gate.wasm) },
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
    root: gateRoot,
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
    await page.waitForFunction(
      () => {
        const state = Reflect.get(globalThis, 'goGate');
        return state.report !== undefined || state.error !== undefined;
      },
      undefined,
      { timeout: 120000 },
    );
    const state = (await page.evaluate(() => Reflect.get(globalThis, 'goGate'))) as PageState;
    return { state, external, wasmBytes: (await readFile(gate.file)).byteLength };
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => {
      server.httpServer.close((error) => (error ? reject(error) : resolve()));
      if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
    });
  }
}

function report(lane: string, wasmBytes: number, value: unknown): void {
  console.info(`go-gate ${lane} ${JSON.stringify({ wasmBytes, ...(value as object) })}`);
}

test.skipIf(!goAvailable)(
  goAvailable ? 'the Go gate passes in real Chromium under the strict CSP' : missingGo,
  async () => {
    const gate = await buildGate();
    const { state, external, wasmBytes } = await runInChromium(true);
    expect(state.error).toBeUndefined();
    expect(state.adapterError).toBeUndefined();
    expect(state.violations).toEqual([]);
    expect(external).toEqual([]);
    const result = state.report;
    expect(result?.error).toBeUndefined();
    expect(result?.violations).toEqual([]);
    expect(result?.compileProbe).toBeNull();
    // Every scenario reproduces the record the native run made.
    expect(result?.scenarios).toEqual(gate.expected);
    // A direct net/http call, including one made while the program initializes, is refused and counted.
    expect(result?.egress).toEqual({ init: 'blocked', http: 'blocked' });
    expect(result?.egressAttempts).toBeGreaterThanOrEqual(2);
    expect(state.adapter?.disposed).toBe(true);
    report('chromium', wasmBytes, { adapter: state.adapter, timings: result?.timings });
    expect(wasmBytes).toBeLessThanOrEqual(maxWasmBytes);
    expect(state.adapter?.wallMs).toBeLessThanOrEqual(maxColdStartMs);
  },
  240000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'the Go gate fails without wasm-unsafe-eval, so the directive is needed'
    : missingGo,
  async () => {
    const { state } = await runInChromium(false);
    // The shipped adapter cannot boot, and compiling even an empty module is refused by the CSP.
    expect(state.adapterError).toBeDefined();
    expect(state.report?.error).toBeDefined();
    expect(state.report?.compileProbe).toMatch(/Content Security Policy|wasm-unsafe-eval/);
  },
  240000,
);

test.skipIf(!goAvailable)(
  goAvailable ? 'the Go gate reproduces the native records on Node' : missingGo,
  async () => {
    const gate = await buildGate();
    const wasm = await readFile(gate.file);
    const server = createServer((request, response) => {
      if (request.url !== gate.wasm.url) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/wasm' }).end(wasm);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The server has no port.');
    const bundle = join(gate.directory, 'node-bundle');
    await build({
      configFile: false,
      root: gateRoot,
      logLevel: 'silent',
      build: {
        ssr: join(gateRoot, 'gate-worker.ts'),
        outDir: bundle,
        emptyOutDir: true,
        rolldownOptions: {
          output: { entryFileNames: 'gate-worker.mjs', chunkFileNames: '[name]-[hash].mjs' },
        },
      },
    });
    await writeFile(
      join(bundle, 'bootstrap.mjs'),
      `import { parentPort } from 'node:worker_threads';
globalThis.postMessage = (message) => parentPort.postMessage(message);
globalThis.addEventListener = (type, listener) => {
  if (type === 'message') parentPort.on('message', (data) => listener({ data }));
};
await import('./gate-worker.mjs');
`,
    );
    const worker = new Worker(join(bundle, 'bootstrap.mjs'));
    try {
      const result = await new Promise<Report>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.postMessage({
          ...gate.wasm,
          url: `http://127.0.0.1:${address.port}${gate.wasm.url}`,
        });
      });
      expect(result.error).toBeUndefined();
      expect(result.scenarios).toEqual(gate.expected);
      expect(result.egress).toEqual({ init: 'blocked', http: 'blocked' });
      expect(result.egressAttempts).toBeGreaterThanOrEqual(2);
      report('node', wasm.byteLength, { timings: result.timings });
    } finally {
      await worker.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  },
  240000,
);
