// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Gate decisions: G4.5 fails in CPython and Node; G4.6 has no latch to measure.
// All remaining SUPPORTED-family gates: not measured, outcome fixed by G4.5.
// AL read, text stream, confirmed write, fatal budget and durable restore run below.
// C1-C5: ALTERNATIVE for those scenarios; C6 keeps shipped refusals.
// Chromium reload, Firefox, WebKit and real providers: not measured.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createRuntime,
  defineAgentDefinition,
  GalaxieError,
  galaxieField,
  type RunEvent,
  type SessionId,
} from '@galaxie-ai/core';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createPythonFixture,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import { MockChatModel } from '../../packages/models/src/mock.js';
import { confirmationsFor } from './support/auto-confirm.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const timeout = 900_000;
const read = { name: 'read@1', input: { value: 2 } };
const write = { name: 'write@1', input: { value: 4 } };

function nativeReference(
  writeOnly = false,
  parallel = false,
): {
  final: string;
  calls: unknown[];
  writes: number;
} {
  return JSON.parse(
    execFileSync(
      fileURLToPath(new URL('../../python/.venv/bin/python', import.meta.url)),
      [
        '-I',
        '-c',
        `import asyncio,json,sys
sys.path.insert(0,'tests/conformance/cases-python')
from test_tool_call_replies_native import native_record
record,_=asyncio.run(native_record(write_only=${writeOnly ? 'True' : 'False'},parallel=${parallel ? 'True' : 'False'}))
print(json.dumps(record))`,
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        timeout,
        env: { ...process.env, LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).toString(),
  );
}

async function fixture(candidate = false) {
  const sources: Record<string, string> = {};
  for (const name of candidate ? ['tool_floor', 'tool_candidate'] : ['tool_loop'])
    sources[`${name}.py`] = await readFile(
      new URL(`./cases-python/${name}.py`, import.meta.url),
      'utf8',
    );
  return createPythonFixture({ sources, module: candidate ? 'tool_floor' : 'tool_loop' });
}

async function runtimeInstance(
  f: Awaited<ReturnType<typeof fixture>>,
  options: {
    failFirst?: boolean;
    privateResult?: boolean;
    budget?: number;
    store?: { checkpoints: MemoryByteCheckpoints; recovery: MemoryRecoveryStore };
    sessionId?: SessionId;
  } = {},
) {
  const model = new MockChatModel({
    read: { id: 'read-text', text: JSON.stringify({ calls: [read] }) },
    write: { id: 'write-text', text: JSON.stringify({ calls: [write] }) },
    parallel: { id: 'parallel-text', text: JSON.stringify({ calls: [read, write] }) },
    'bad-text': {
      id: 'bad-text',
      text: JSON.stringify({ calls: [{ name: 'unknown@1', input: {} }] }),
    },
    '["4"]': { id: 'final-read', text: 'done' },
    '["saved"]': { id: 'final-write', text: 'done' },
    '["4","saved"]': { id: 'final-parallel', text: 'done' },
    candidate: {
      id: 'candidate',
      text: '',
      toolCalls: [{ id: 'call-1', name: 'read', args: { value: 2 } }],
    },
  });
  const calls: unknown[] = [];
  let attempts = 0;
  let writes = 0;
  const runtime = createRuntime({
    appId: 'python-tool-replies',
    executors: [createPyodideAdapter(f.options)],
    outputSafety: () => 'allow',
    ...(options.budget === undefined ? {} : { budgets: { toolCalls: options.budget } }),
  });
  const input = z.object({ value: z.number().int() });
  const destination = options.privateResult ? ('host-server' as const) : ('in-browser' as const);
  const binding = {
    destination: 'in-browser' as const,
    timeoutMs: 1000,
    concurrency: 1,
    grantScope: 'instance' as const,
    retry: 'none' as const,
  };
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/python-tool-replies',
      version: '1',
      executor: 'langgraph-python',
      input: z.unknown(),
      models: { answer: { modality: 'text', defaultPolicy: 'remote-allowed' } },
      capabilities: {
        required: {
          'read@1': {
            kind: 'read',
            input,
            output: options.privateResult
              ? z.string().meta(galaxieField({ label: 'private-user' }))
              : z.string(),
          },
          'write@1': { kind: 'write', input, output: z.string() },
        },
      },
    }),
    {
      principalScope: 'fixture',
      agent: f.agent,
      confirmations: confirmationsFor(['write@1'], 'tool-spike-v1'),
      ...(options.store ? { recovery: options.store.recovery } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      services: {
        chatModels: { mock: model },
        ...(options.store ? { checkpoints: options.store.checkpoints } : {}),
      },
      models: {
        providers: {
          mock: {
            destination,
            modality: 'text',
            features: ['streaming', 'tool-calling'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { answer: { providers: ['mock'], allow: [destination], maxTokens: 100 } },
        consent: () => true,
      },
      bindings: {
        'read@1': {
          ...binding,
          kind: 'read',
          approval: 'none',
          invoke: async (value) => {
            attempts++;
            if (options.failFirst && attempts === 1)
              throw new GalaxieError('unavailable', 'The requested service is unavailable.');
            calls.push(['read@1', value]);
            return '4';
          },
        },
        'write@1': {
          ...binding,
          kind: 'write',
          approval: 'confirm',
          invoke: async (value) => {
            writes++;
            calls.push(['write@1', value]);
            return 'saved';
          },
        },
      },
    },
  );
  await instance.prepare();
  return { runtime, instance, model, calls, counts: () => ({ writes, attempts }) };
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const result: RunEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

test.skipIf(!pythonWheelsAvailable).each([
  { scenario: 'read', stream: false },
  { scenario: 'read', stream: true },
  { scenario: 'parallel', stream: false },
])(
  'text protocol matches native calls and final text: %j',
  async ({ scenario, stream }) => {
    const f = await fixture();
    const r = await runtimeInstance(f);
    try {
      const reference = nativeReference(false, scenario === 'parallel');
      const { runId } = await r.instance.start({ scenario, stream });
      const events = collect(r.instance.events(runId));
      if (scenario === 'parallel') {
        await expect.poll(() => r.instance.getSnapshot().confirmations?.length).toBe(1);
        expect(r.counts().writes).toBe(0);
        const pending = r.instance.getSnapshot().confirmations?.[0];
        if (!pending) throw new Error('Missing confirmation.');
        expect(r.instance.respond(pending.id, 'approve')).toEqual({ status: 'approved' });
      }
      expect((await events).find((event) => event.type === 'output')).toMatchObject({
        output: { final: reference.final, calls: reference.calls },
      });
      expect(r.calls).toEqual(reference.calls);
      expect(r.counts().writes).toBe(reference.writes);
      expect(r.instance.getSnapshot().run?.status).toBe('succeeded');
      expect(f.workerErrors).toEqual([]);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each(['approve', 'decline'] as const)(
  'text-protocol write waits for host confirmation: %s',
  async (decision) => {
    const f = await fixture();
    const r = await runtimeInstance(f);
    try {
      const reference = nativeReference(true);
      const { runId } = await r.instance.start({ scenario: 'write' });
      const events = collect(r.instance.events(runId));
      await expect.poll(() => r.instance.getSnapshot().confirmations?.length).toBe(1);
      const pending = r.instance.getSnapshot().confirmations?.[0];
      if (!pending) throw new Error('Missing confirmation.');
      expect(r.counts().writes).toBe(0);
      expect(pending.arguments).toEqual({ value: 4 });
      expect(Object.isFrozen(pending.arguments)).toBe(true);
      r.instance.respond(pending.id, decision);
      const result = await events;
      if (decision === 'approve') {
        expect(result.find((event) => event.type === 'output')).toMatchObject({
          output: { final: reference.final, calls: reference.calls },
        });
        expect(r.calls).toEqual(reference.calls);
        expect(r.counts().writes).toBe(reference.writes);
      } else {
        expect(r.instance.getSnapshot().run?.error?.code).toBe('denied');
        expect(r.counts().writes).toBe(0);
        expect(r.model.calls).toBe(1);
      }
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'text-protocol terminal budget errors escape before host dispatch',
  async () => {
    const f = await fixture();
    const r = await runtimeInstance(f, { budget: 0 });
    try {
      const { runId } = await r.instance.start({ scenario: 'read' });
      await collect(r.instance.events(runId));
      expect(r.instance.getSnapshot().run?.error?.code).toBe('budget_exceeded');
      expect(r.calls).toEqual([]);
      expect(r.model.calls).toBe(1);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each(['boolean', 'callable'])(
  'candidate fails the swallowed-error floor through core: %s',
  async (handler) => {
    const f = await fixture(true);
    const r = await runtimeInstance(f, { failFirst: true });
    try {
      const { runId } = await r.instance.start({ handler, again: true });
      await collect(r.instance.events(runId));
      expect(r.instance.getSnapshot().run?.error?.code).toBe('unsupported');
      expect(r.counts().attempts).toBe(2);
      expect(r.calls).toEqual([['read@1', { value: 2 }]]);
      expect(r.model.calls).toBe(1);
      // The same prepared Worker stays usable; this is not a passing latch test.
      const next = await r.instance.start({ handler, again: false });
      await collect(r.instance.events(next.runId));
      expect(r.instance.getSnapshot().run?.status).toBe('succeeded');
      expect(f.counts.created).toBe(1);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each([false, true])(
  'text protocol restores with one confirmed write (replay=%s)',
  async (replay) => {
    const f = await fixture();
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const first = await runtimeInstance(f, { store });
    let second: Awaited<ReturnType<typeof runtimeInstance>> | undefined;
    try {
      const reference = nativeReference(true);
      const { runId } = await first.instance.start({ scenario: 'write', durable: true, replay });
      const waiting = (async () => {
        for await (const event of first.instance.events(runId)) {
          if (event.type === 'error') return event.error;
          if (event.type === 'interaction') return;
        }
        throw new Error('Missing durable pause.');
      })();
      await expect.poll(() => first.instance.getSnapshot().confirmations?.length).toBe(1);
      const confirmation = first.instance.getSnapshot().confirmations?.[0];
      if (!confirmation) throw new Error('Missing confirmation.');
      first.instance.respond(confirmation.id, 'approve');
      expect(await waiting).toBeUndefined();
      expect(first.counts().writes).toBe(reference.writes);
      const sessionId = first.instance.sessionId;
      await first.runtime.dispose();
      second = await runtimeInstance(f, { store, sessionId });
      const restored = await second.instance.restore();
      if (!restored) throw new Error('Missing restored run.');
      const pending = second.instance.getSnapshot().run?.pending;
      if (!pending) throw new Error('Missing restored interaction.');
      expect(
        await second.instance.dispatch({
          instanceId: second.instance.instanceId,
          runId: restored.runId,
          ...pending,
          action: 'submit',
          payload: false,
        }),
      ).toMatchObject({ status: 'accepted' });
      expect(
        (await collect(second.instance.events(restored.runId))).find(
          (event) => event.type === 'output',
        ),
      ).toMatchObject({
        output: { final: reference.final, calls: reference.calls },
      });
      expect([...first.calls, ...second.calls]).toEqual(reference.calls);
      expect(second.counts().writes).toBe(0);
      expect(f.counts.created).toBe(2);
    } finally {
      await first.runtime.dispose();
      await second?.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'text-protocol private results refuse the next host-server model dispatch',
  async () => {
    const f = await fixture();
    const r = await runtimeInstance(f, { privateResult: true });
    try {
      const { runId } = await r.instance.start({ scenario: 'read' });
      await collect(r.instance.events(runId));
      expect(r.instance.getSnapshot().run?.error?.code).toBe('denied');
      expect(r.instance.getSnapshot().run?.labels).toContain('private-user');
      expect(r.model.calls).toBe(1);
      expect(r.calls).toEqual([['read@1', { value: 2 }]]);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'text protocol refuses unlisted names before broker dispatch',
  async () => {
    const f = await fixture();
    const r = await runtimeInstance(f);
    try {
      const { runId } = await r.instance.start({ scenario: 'bad-text' });
      await collect(r.instance.events(runId));
      expect(r.instance.getSnapshot().run?.error?.code).toBe('invalid');
      expect(r.calls).toEqual([]);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);
