// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { scanMarkers } from '../src/coverage-readback.js';
import { probeGoVersion } from '../src/families/go.js';
import { createProvider } from '../src/families/provider.js';
import { probePyodide } from '../src/families/pyodide.js';

test('marker scan detects text before projection', () => {
  expect(() => scanMarkers({ nested: { text: 'scan-control' } }, ['scan-control'])).toThrow(
    'Trace content marker',
  );
  scanMarkers({ nested: { text: 'clean' } }, ['scan-control']);
});

test('offline provider captures real spans without an exporter', async () => {
  const host = createProvider();
  try {
    host.provider.getTracer('coverage-control').startSpan('captured-control').end();
    await host.flush();
    expect(host.oracle.getFinishedSpans().map((span) => span.name)).toEqual(['captured-control']);
    host.oracle.reset();
    expect(host.oracle.getFinishedSpans()).toEqual([]);
  } finally {
    await host.shutdown();
  }
});

test('ADK resolves to the adapter copy', () => {
  expect(realpathSync(new URL('../node_modules/@google/adk', import.meta.url))).toBe(
    realpathSync(
      new URL('../../../packages/adapter-adk/node_modules/@google/adk', import.meta.url),
    ),
  );
});

test('missing wheels produce a reasoned unmeasured probe without booting Python', async () => {
  const cache = mkdtempSync(join(tmpdir(), 'llmops-empty-wheels-'));
  try {
    expect(await probePyodide(cache)).toMatchObject({
      measurement: 'unmeasured',
      reason: expect.stringContaining('local-wheels.json'),
      probes: expect.any(Array),
    });
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('Go lock mismatch is unmeasured without invoking a toolchain', async () => {
  expect(await probeGoVersion('go0.0.0')).toMatchObject({
    measurement: 'unmeasured',
    reason: expect.stringContaining('go0.0.0'),
    probes: expect.any(Array),
  });
});
