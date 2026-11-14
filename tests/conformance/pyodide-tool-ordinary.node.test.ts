// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import {
  createRuntime,
  defineAgentDefinition,
  type ErrorCode,
  GalaxieError,
  galaxieField,
  type RunEvent,
} from '@galaxie-ai/core';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createPythonFixture } from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { MockChatModel } from '../../packages/models/src/mock.js';
import { confirmationsFor } from './support/auto-confirm.js';

interface Probe {
  scenario?: string;
  privateResult?: boolean;
  budget?: number;
  coverage?: boolean;
  decision?: 'approve' | 'decline';
  failure?: ErrorCode;
  outputDenied?: boolean;
  state?: Record<string, unknown>;
}

async function measure(probe: Probe = {}): Promise<{
  events: RunEvent[];
  calls: unknown[];
  models: number;
  wire: unknown[];
  frozen: boolean;
}> {
  const source = await readFile(
    new URL('./cases-python/tool_ordinary.py', import.meta.url),
    'utf8',
  );
  const fixture = await createPythonFixture({
    sources: { 'tool_ordinary.py': source },
    module: 'tool_ordinary',
  });
  const calls: unknown[] = [];
  let frozen = true;
  const model = new MockChatModel({
    read: {
      id: 'ordinary-read',
      text: JSON.stringify({ calls: [{ name: 'read', input: { value: 2 } }] }),
    },
    write: {
      id: 'ordinary-write',
      text: JSON.stringify({ calls: [{ name: 'write', input: { value: 4 } }] }),
    },
    three: {
      id: 'ordinary-three',
      text: JSON.stringify({
        calls: [0, 1, 2].map((value) => ({ name: 'read', input: { value } })),
      }),
    },
    bad: {
      id: 'ordinary-bad',
      text: JSON.stringify({ calls: [{ name: 'read', input: { value: 'bad' } }] }),
    },
    finish: { id: 'ordinary-finish', text: 'done' },
  });
  const runtime = createRuntime({
    appId: 'ordinary-tool-measurement',
    executors: [createPyodideAdapter(fixture.options)],
    outputSafety: () => (probe.outputDenied ? 'block' : 'allow'),
    ...(probe.budget === undefined ? {} : { budgets: { toolCalls: probe.budget } }),
  });
  try {
    const destination = probe.privateResult ? ('host-server' as const) : ('in-browser' as const);
    const input = z.object({ value: z.number().int() });
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'conformance/ordinary-tool',
        version: '1',
        executor: 'langgraph-python',
        input: z.unknown(),
        models: { answer: { modality: 'text', defaultPolicy: 'remote-allowed' } },
        capabilities: {
          required: {
            'read@1': {
              kind: 'read',
              input,
              output: probe.privateResult
                ? z.string().meta(galaxieField({ label: 'private-user' }))
                : z.string(),
            },
            'write@1': { kind: 'write', input, output: z.string() },
          },
          optional: { 'ungranted@1': { kind: 'read', input, output: z.string() } },
        },
      }),
      {
        principalScope: 'fixture',
        agent: fixture.agent,
        ...(probe.coverage === false
          ? {}
          : { confirmations: confirmationsFor(['write@1'], 'ordinary-v1') }),
        services: { chatModels: { mock: model } },
        models: {
          providers: {
            mock: {
              destination,
              modality: 'text',
              features: ['streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: [destination], maxTokens: 100 } },
          consent: () => true,
        },
        bindings: {
          'ungranted@1': {
            kind: 'read',
            destination: 'in-browser',
            approval: 'none',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'run',
            retry: 'none',
            invoke: async (value) => {
              calls.push(['ungranted@1', value]);
              return '4';
            },
          },
          'read@1': {
            kind: 'read',
            destination: 'in-browser',
            approval: 'none',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            retry: 'none',
            invoke: async (value) => {
              if (probe.failure) throw new GalaxieError(probe.failure, 'A counted host refusal.');
              calls.push(['read@1', value]);
              return '4';
            },
          },
          'write@1': {
            kind: 'write',
            destination: 'in-browser',
            approval: 'confirm',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            retry: 'none',
            invoke: async (value) => {
              frozen = Object.isFrozen(value);
              calls.push(['write@1', value]);
              return 'saved';
            },
          },
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({ scenario: probe.scenario ?? 'read', ...probe.state });
    const events: RunEvent[] = [];
    const collecting = (async () => {
      for await (const event of instance.events(runId)) events.push(event);
    })();
    if (probe.scenario === 'write' && probe.coverage !== false) {
      await expect.poll(() => instance.getSnapshot().confirmations?.length).toBe(1);
      expect(calls).toHaveLength(0);
      const pending = instance.getSnapshot().confirmations?.[0];
      if (!pending) throw new Error('Missing confirmation.');
      instance.respond(pending.id, probe.decision ?? 'approve');
    }
    await collecting;
    const wire = fixture.fromWorker
      .map((raw) => JSON.parse(raw))
      .filter((message) => message.kind === 'request' && message.op === 'capability')
      .map((message) => message.payload);
    return { events, calls, models: model.calls, wire, frozen };
  } finally {
    await runtime.dispose();
    await fixture.cleanup();
  }
}

function error(events: RunEvent[]): unknown {
  return events.find((event) => event.type === 'error');
}
function output(events: RunEvent[]): unknown {
  return events.find((event) => event.type === 'output');
}

test('O1 ordinary body retains sticky result labels', async () => {
  const result = await measure({ privateResult: true });
  expect(error(result.events)).toMatchObject({ error: { code: 'denied' } });
  expect(result.models).toBe(1);
  expect(result.calls).toHaveLength(1);
}, 900_000);

test('O2 ordinary body retains broker tool budgets', async () => {
  const result = await measure({ scenario: 'three', budget: 2 });
  expect(error(result.events)).toMatchObject({ error: { code: 'budget_exceeded' } });
  expect(result.calls).toHaveLength(2);
}, 900_000);

test.each(['approve', 'decline'] as const)(
  'O3 ordinary write confirmation: %s',
  async (decision) => {
    const result = await measure({ scenario: 'write', decision });
    expect(result.calls).toHaveLength(decision === 'approve' ? 1 : 0);
    expect(result.frozen).toBe(true);
    if (decision === 'approve')
      expect(output(result.events)).toMatchObject({
        output: { final: 'done', results: ['saved'] },
      });
    else expect(error(result.events)).toMatchObject({ error: { code: 'denied' } });
  },
  900_000,
);

test('O3/S4 missing confirmation coverage refuses before dispatch', async () => {
  const result = await measure({ scenario: 'write', coverage: false });
  expect(error(result.events)).toMatchObject({ error: { code: 'invalid' } });
  expect(result.calls).toEqual([]);
}, 900_000);

test('O5 non-flagged body still encounters broker confirmation policy', async () => {
  const result = await measure({ scenario: 'write', coverage: false, state: { flagged: false } });
  expect(error(result.events)).toMatchObject({ error: { code: 'unsupported' } });
  expect(result.calls).toEqual([]);
  expect(result.wire).toMatchObject([{ name: 'write@1' }]);
  expect(result.wire[0]).not.toHaveProperty('tool');
}, 900_000);

test.each([
  'cancelled',
  'timeout',
  'unavailable',
  'outcome_unknown',
  'unrecoverable',
  'denied',
] as const)(
  'O4 default handler retains %s',
  async (failure) => {
    const result = await measure({ failure });
    expect(error(result.events)).toMatchObject({ error: { code: failure } });
    expect(result.models).toBe(1);
  },
  900_000,
);

test.each(['true', 'callable'])(
  'O6 explicit %s handler can swallow host unavailable',
  async (handler) => {
    const result = await measure({ failure: 'unavailable', state: { handler } });
    expect(error(result.events)).toBeUndefined();
    expect(output(result.events)).toMatchObject({ output: { final: 'done', statuses: ['error'] } });
    expect(result.models).toBe(2);
  },
  900_000,
);

test('S1 native pydantic validation spends no broker budget', async () => {
  const result = await measure({ scenario: 'bad', budget: 0, state: { pydantic: true } });
  expect(result.wire).toEqual([]);
  expect(result.calls).toEqual([]);
  expect(output(result.events)).toMatchObject({ output: { final: 'done', statuses: ['error'] } });
}, 900_000);

test('S2 dict schema invalid arguments reach broker without host dispatch', async () => {
  const result = await measure({ scenario: 'bad' });
  expect(error(result.events)).toMatchObject({ error: { code: 'invalid' } });
  expect(result.wire).toHaveLength(1);
  expect(result.calls).toEqual([]);
}, 900_000);

test('S3 output policy refuses before capability dispatch', async () => {
  const result = await measure({ outputDenied: true });
  expect(error(result.events)).toMatchObject({ error: { code: 'denied' } });
  expect(result.calls).toEqual([]);
}, 900_000);

test.each([
  ['ungranted@1', 'denied'],
  ['unknown@1', 'invalid'],
  ['unbound@1', 'invalid'],
])(
  'S3/S4 capability %s refusal is %s',
  async (capability, code) => {
    const result = await measure({ state: { capability } });
    expect(error(result.events)).toMatchObject({ error: { code } });
    expect(result.calls).toEqual([]);
  },
  900_000,
);

test('S4 invalid tool flag fails before capability request', async () => {
  const result = await measure({ state: { flagged: 'bad' } });
  expect(error(result.events)).toMatchObject({ error: { code: 'invalid' } });
  expect(result.wire).toEqual([]);
}, 900_000);

test.each(['true', 'callable'])(
  'O6 natural broker budget remains terminal under %s handler',
  async (handler) => {
    const result = await measure({ budget: 0, state: { handler } });
    expect(error(result.events)).toMatchObject({ error: { code: 'budget_exceeded' } });
    expect(result.calls).toEqual([]);
  },
  900_000,
);
