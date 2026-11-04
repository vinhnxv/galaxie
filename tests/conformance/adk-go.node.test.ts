// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { runCase } from '../../examples/rag-browser/test/support/adk-go-ref/run.js';
import { createGoAdapter } from '../../packages/adapter-go/src/index.js';
import {
  buildReference,
  disposeReference,
  goAvailable,
  maxColdStartMs,
  maxWasmBytes,
  missingGo,
  type NodeHost,
  type Observed,
  type Reference,
  readGolden,
  readScripts,
  type Script,
  startNodeHost,
} from './support/adk-go.node.js';

const scripts = await readScripts();
const caseNames = Object.keys(scripts);
let reference: Reference | undefined;
let host: NodeHost | undefined;

beforeAll(async () => {
  if (!goAvailable) return;
  reference = await buildReference();
  host = await startNodeHost(reference);
}, 600000);
afterAll(async () => {
  await host?.close();
  await disposeReference();
});

test('the matrix lists every case and the adapter features', async () => {
  const matrix = JSON.parse(
    await readFile(new URL('./compatibility-matrix-adk-go.json', import.meta.url), 'utf8'),
  ) as { cases: string[]; differences: unknown[]; features: Record<string, boolean> };
  expect([...matrix.cases].sort()).toEqual([...caseNames].sort());
  expect(matrix.differences).toEqual([]);
  const adapter = createGoAdapter({
    createWorker: () => {
      throw new Error('The matrix check starts no Worker.');
    },
  });
  expect(matrix.features).toEqual(adapter.features);
});

function runOnNode(name: string, script: Script): Promise<Observed> {
  if (!host) throw new Error('The host did not start.');
  const nodeHost = host;
  return runCase(name, script, nodeHost.wasm, () => nodeHost.createWorker());
}

test.skipIf(!goAvailable).each(caseNames)(
  goAvailable ? 'the Node Worker reproduces the native golden for %s' : missingGo,
  async (name) => {
    const script = scripts[name] as Script;
    const golden = await readGolden(name);
    const observed = await runOnNode(name, script);
    expect({
      requests: observed.requests,
      responses: observed.responses,
      capabilities: observed.capabilities,
      output: observed.output,
      error: observed.error,
    }).toEqual(golden);
  },
  120000,
);

/** Reads a module's checksum from go.sum, the file the build verifies against. */
async function goSum(path: string, version: string): Promise<string> {
  const sums = await readFile(new URL('../../go/go.sum', import.meta.url), 'utf8');
  const line = sums.split('\n').find((entry) => entry.startsWith(`${path} ${version} h1:`));
  if (!line) throw new Error(`go.sum has no ${path} ${version}.`);
  return line.split(' ')[2] as string;
}

test.skipIf(!goAvailable)(
  goAvailable ? 'the module reports the pinned toolchain and Go dependencies' : missingGo,
  async () => {
    if (!host) throw new Error('The host did not start.');
    const nodeHost = host;
    const expected = {
      go: 'go1.27.3',
      adk: { version: 'v1.9.0', sum: await goSum('google.golang.org/adk', 'v1.9.0') },
      genai: { version: 'v1.57.0', sum: await goSum('google.golang.org/genai', 'v1.57.0') },
    };
    const agent = { wasm: nodeHost.wasm, entry: 'single' };
    const services = { chatModels: {} };
    const signal = new AbortController().signal;
    const matching = await createGoAdapter({
      createWorker: () => nodeHost.createWorker(),
      expectedBuild: expected,
    }).prepare(agent, services, { signal });
    await matching.dispose();
    await expect(
      createGoAdapter({
        createWorker: () => nodeHost.createWorker(),
        expectedBuild: { ...expected, adk: { ...expected.adk, sum: 'h1:tampered' } },
      }).prepare(agent, services, { signal }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable ? 'the reference module stays within the size and cold-start limits' : missingGo,
  async () => {
    if (!reference) throw new Error('The reference module was not built.');
    const raw = (await readFile(reference.file)).byteLength;
    const observed = await runOnNode('plain-text', scripts['plain-text'] as Script);
    console.info(
      `adk-go node ${JSON.stringify({ wasmBytes: raw, coldStartMs: observed.coldStartMs })}`,
    );
    expect(raw).toBeLessThanOrEqual(maxWasmBytes);
    expect(observed.coldStartMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(maxColdStartMs);
  },
  120000,
);
