// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { MAX_BRIDGE_BYTES } from '../../packages/adapter-pyodide/src/bridge.js';
import { executeDspyStateCase } from './support/dspy-state.js';
import { limitSources, stateLimitSpec, syntheticState } from './support/dspy-state-limits.js';
import { selectedStateSource } from './support/dspy-state-sources.node.js';

async function probe(
  bytes: number,
  escaped = false,
  pickle = false,
): Promise<{
  transcript: Awaited<ReturnType<typeof executeDspyStateCase>>;
  demos: number;
  counts: { created: number; terminated: number };
  requests: readonly { url: string; bytes: number }[];
  bootMs: number | undefined;
  booted: boolean;
  requestBytes: number | undefined;
}> {
  const state = syntheticState(bytes, escaped);
  const sources = limitSources(
    await readFile(new URL('./cases-dspy/state_suite.py', import.meta.url), 'utf8'),
    selectedStateSource('state-limits'),
    state.text,
  );
  const fixture = await createPythonFixture({ framework: 'dspy', module: 'selected', sources });
  try {
    const transcript = await executeDspyStateCase(
      fixture.options,
      pickle ? { ...fixture.agent, files: [...fixture.agent.files, 'state.pkl'] } : fixture.agent,
      'state-limits',
      stateLimitSpec,
    );
    expect(fixture.workerErrors).toEqual([]);
    // Capture the actual bridge request (including protocol envelope and escaping).
    const frame = fixture.fromWorker.find((text) => {
      const value = JSON.parse(text) as { op?: string };
      return value.op === 'model';
    });
    return {
      transcript,
      demos: state.demos,
      counts: { ...fixture.counts },
      requests: [...fixture.requests],
      bootMs: fixture.bootEvents.find((event) => event.phase === 'ready')?.coldStartMs,
      booted: fixture.bootEvents.some((event) => event.phase === 'ready'),
      requestBytes: frame === undefined ? undefined : new TextEncoder().encode(frame).byteLength,
    };
  } finally {
    await fixture.cleanup();
  }
}

test('a 256 KiB JSON state loads all demos into the model request', async () => {
  const result = await probe(256 * 1024);
  expect(result.transcript.error).toBeNull();
  expect(result.transcript.output).toMatchObject({ answer: 'Paris', demos: result.demos });
  const request = result.transcript.requests[0] as { messages: unknown[] };
  expect(request.messages).toHaveLength(2 + 2 * result.demos);
}, 60000);

test.each([
  { bytes: MAX_BRIDGE_BYTES + 1, code: 'invalid', counts: { created: 0, terminated: 0 } },
  { bytes: MAX_BRIDGE_BYTES - 100, code: 'unsupported', counts: { created: 1, terminated: 1 } },
])(
  'state size $bytes fails $code at its responsible boundary',
  async ({ bytes, code, counts }) => {
    const result = await probe(bytes);
    expect(result.transcript.error).toMatchObject({ code });
    expect(result.transcript.requests).toEqual([]);
    expect(result.counts).toEqual(counts);
  },
  60000,
);

test('a pickle source is refused before source fetch or Worker creation', async () => {
  const result = await probe(1024, false, true);
  expect(result.transcript.error).toMatchObject({ code: 'invalid' });
  expect(result.requests).toEqual([]);
  expect(result.counts).toEqual({ created: 0, terminated: 0 });
}, 60000);

test('JSON escaping reduces the accepted raw state size', async () => {
  const plain = await probe(768 * 1024);
  const escaped = await probe(768 * 1024, true);
  expect(plain.transcript.error).toBeNull();
  expect(escaped.transcript.error).toMatchObject({ code: 'unsupported' });
  expect(escaped.booted).toBe(false);
}, 60000);

test.skipIf(process.env['GALAXIE_DSPY_STATE_MEASURE'] !== '1')(
  'measure the boot boundary and load costs without timing thresholds',
  async () => {
    let accepted = 256 * 1024;
    let refused = MAX_BRIDGE_BYTES - 100;
    while (refused - accepted > 1024) {
      const bytes = Math.floor((accepted + refused) / 2);
      const result = await probe(bytes);
      if (result.booted) accepted = bytes;
      else refused = bytes;
    }
    console.log(
      JSON.stringify({
        largestAcceptedBytes: accepted,
        firstRefusedBytes: refused,
        resolutionBytes: refused - accepted,
      }),
    );
    for (const stateBytes of [1024, 256 * 1024, accepted]) {
      const result = await probe(stateBytes);
      console.log(
        JSON.stringify({
          stateBytes,
          bootMs: result.bootMs,
          loadMs: (result.transcript.output as { loadMs?: number } | null)?.loadMs,
          outcome: result.transcript.error ?? 'completed',
          modelRequestBytes: result.requestBytes,
          modelRequestHeadroomBytes:
            result.requestBytes === undefined ? undefined : MAX_BRIDGE_BYTES - result.requestBytes,
        }),
      );
    }
  },
  300000,
);
