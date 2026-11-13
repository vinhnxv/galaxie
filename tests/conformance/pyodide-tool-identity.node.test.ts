// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  createRuntime,
  defineAgentDefinition,
  type ErrorCode,
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
import { parseByteRequest } from '../../packages/storage-indexeddb/src/byte-records.js';
import { confirmationsFor } from './support/auto-confirm.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

const timeout = 900_000;
const call = { id: 'call-1', name: 'read', args: { value: 2 } };
const final = { id: 'final', text: 'done' };
const terminal: readonly ErrorCode[] = [
  'budget_exceeded',
  'cancelled',
  'timeout',
  'unavailable',
  'outcome_unknown',
  'unrecoverable',
];

async function fixture(module = 'tool_scoped_floor') {
  const sources: Record<string, string> = {};
  for (const name of new Set([
    'tool_candidate',
    'tool_scope',
    'tool_scoped_candidate',
    'tool_scoped_floor',
    module,
  ]))
    sources[`${name}.py`] = await readFile(
      new URL(`./cases-python/${name}.py`, import.meta.url),
      'utf8',
    );
  return createPythonFixture({ sources, module });
}

type Store = { checkpoints: MemoryByteCheckpoints; recovery: MemoryRecoveryStore };

async function runtimeInstance(
  f: Awaited<ReturnType<typeof fixture>>,
  options: {
    failure?: ErrorCode;
    budget?: number;
    steps?: number;
    privateResult?: boolean;
    missingFeature?: boolean;
    missingBind?: boolean;
    writeBinding?: 'none' | 'unbound' | 'uncovered';
    blocked?: boolean;
    oversized?: boolean;
    store?: Store;
    sessionId?: SessionId;
    hostDelay?: boolean;
    hostTimeout?: boolean;
    adapter?: ReturnType<typeof createPyodideAdapter>;
    model?: MockChatModel;
  } = {},
) {
  const model =
    options.model ??
    new MockChatModel({
      read: [{ id: 'calls', text: '', toolCalls: [call] }, final],
      write: [
        { id: 'calls', text: '', toolCalls: [{ ...call, name: 'write', args: { value: 4 } }] },
        final,
      ],
      parallel: [
        { id: 'calls', text: '', toolCalls: [call, { ...call, id: 'call-2', args: { value: 4 } }] },
        final,
      ],
      'parallel-write': [
        {
          id: 'calls',
          text: '',
          toolCalls: [call, { ...call, id: 'call-2', name: 'write', args: { value: 4 } }],
        },
        final,
      ],
      'two-writes': [
        {
          id: 'calls',
          text: '',
          toolCalls: [
            { ...call, name: 'write' },
            { ...call, id: 'call-2', name: 'write', args: { value: 4 } },
          ],
        },
        final,
      ],
      'bad-arguments': [
        {
          id: 'calls',
          text: '',
          toolCalls: [{ ...call, args: { value: 'PRIVATE-MARKER-argument' } }],
        },
        final,
      ],
      'plain-text': { id: 'plain', text: 'done' },
    });
  if (options.missingBind) Object.defineProperty(model, 'bindTools', { value: undefined });
  let failure = options.failure;
  let attempts = 0;
  let writes = 0;
  const calls: unknown[] = [];
  const effects: string[] = [];
  const runtime = createRuntime({
    appId: 'python-tool-identity',
    executors: [options.adapter ?? createPyodideAdapter(f.options)],
    outputSafety: () => (options.blocked ? 'block' : 'allow'),
    budgets: {
      ...(options.budget === undefined ? {} : { toolCalls: options.budget }),
      ...(options.steps === undefined ? {} : { steps: options.steps }),
      ...(options.oversized ? { payloadBytes: 4_194_304 } : {}),
    },
  });
  const input = z.object({ value: z.number().int() });
  const destination = options.privateResult ? ('host-server' as const) : ('in-browser' as const);
  const binding = {
    destination: 'in-browser' as const,
    timeoutMs: options.hostTimeout ? 5 : 1000,
    concurrency: 2,
    grantScope: 'instance' as const,
    retry: 'none' as const,
  };
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/python-tool-identity',
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
          ...(options.writeBinding === 'unbound'
            ? {}
            : {
                'write@1': { kind: 'write', input, output: z.string() },
              }),
        },
      },
    }),
    {
      principalScope: 'fixture',
      agent: f.agent,
      ...(options.writeBinding === 'uncovered'
        ? {}
        : { confirmations: confirmationsFor(['write@1'], 'identity-v1') }),
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
            features: options.missingFeature ? ['streaming'] : ['streaming', 'tool-calling'],
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
          invoke: async (value, context) => {
            attempts++;
            if (failure) throw new GalaxieError(failure, 'Fixed fixture failure.');
            if (options.hostDelay || options.hostTimeout)
              await new Promise((resolve) => setTimeout(resolve, 100));
            calls.push(['read@1', value]);
            effects.push(context.effectId);
            return options.oversized ? 'x'.repeat(1_048_576) : '4';
          },
        },
        ...(options.writeBinding === 'unbound'
          ? {}
          : {
              'write@1': {
                ...binding,
                kind: 'write' as const,
                approval:
                  options.writeBinding === 'none' ? ('none' as const) : ('confirm' as const),
                invoke: async (value: unknown, context: { readonly effectId: string }) => {
                  writes++;
                  calls.push(['write@1', value]);
                  effects.push(context.effectId);
                  return 'saved';
                },
              },
            }),
      },
    },
  );
  await instance.prepare();
  return {
    runtime,
    instance,
    model,
    calls,
    effects,
    counts: () => ({ attempts, writes }),
    fail: (code?: ErrorCode) => {
      failure = code;
    },
  };
}

async function collect(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const result: RunEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function run(r: Awaited<ReturnType<typeof runtimeInstance>>, input: unknown = {}) {
  const { runId } = await r.instance.start(input);
  return collect(r.instance.events(runId));
}

function output(events: readonly RunEvent[]): unknown {
  return events.find((event) => event.type === 'output')?.output;
}

function requests(f: Awaited<ReturnType<typeof fixture>>, op: string): unknown[] {
  return f.fromWorker
    .map((raw) => JSON.parse(raw))
    .filter((message) => message.kind === 'request' && message.op === op);
}

function nativeReference(parallel: boolean): {
  final: string;
  messages: unknown[];
  calls: unknown[];
  models: number;
  tools: number;
} {
  return JSON.parse(
    execFileSync(
      fileURLToPath(new URL('../../python/.venv/bin/python', import.meta.url)),
      [
        '-I',
        '-c',
        `import asyncio,json,sys
sys.path.insert(0,'tests/conformance/cases-python')
from tool_identity_reference import record
print(json.dumps(asyncio.run(record(parallel=${parallel ? 'True' : 'False'}))))`,
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

test.skipIf(!pythonWheelsAvailable)(
  'N3: one scope reaches all tasks and fresh runs have new ids',
  async () => {
    const f = await fixture();
    const r = await runtimeInstance(f);
    try {
      let previous = 0;
      for (let i = 0; i < 2; i++) {
        const result = output(await run(r, { scenario: 'parallel' })) as {
          final: string;
          scope_ids: [string, number][];
          scope_fields: string[];
        };
        expect(result.final).toBe('done');
        expect(result.scope_ids.map(([kind]) => kind)).toEqual([
          'model',
          'subgraph',
          'gather',
          'gather',
          'read',
          'read',
          'next-model',
        ]);
        const ids = result.scope_ids.map(([, id]) => id);
        expect(new Set(ids).size).toBe(1);
        expect(ids[0]).toBeGreaterThan(previous);
        previous = ids[0] ?? 0;
        expect(result.scope_fields).toEqual(['id', 'failure']);
      }
      expect(f.counts.created).toBe(1);
      expect(f.workerErrors).toEqual([]);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each(terminal)(
  'G4.5/G4.6/G4.8: contain %s under both handlers and graph endings',
  async (code) => {
    const f = await fixture();
    const r = await runtimeInstance(
      f,
      code === 'budget_exceeded' ? { budget: 1 } : { failure: code },
    );
    try {
      for (const handler of ['boolean', 'callable']) {
        for (const shape of ['next-model', 'silent', 'next-helper']) {
          const before = {
            model: r.model.calls,
            host: r.counts().attempts,
            bridge: requests(f, 'capability').length,
          };
          await run(r, {
            handler,
            silent: shape === 'silent',
            again: shape === 'next-helper' ? 'write' : false,
            scenario: code === 'budget_exceeded' ? 'parallel' : 'read',
          });
          expect(r.instance.getSnapshot().run?.error?.code).toBe(code);
          expect(r.model.calls - before.model).toBe(1);
          expect(r.counts().attempts - before.host).toBe(1);
          expect(requests(f, 'capability').length - before.bridge).toBe(
            code === 'budget_exceeded' ? 2 : 1,
          );
          expect(r.counts().writes).toBe(0);
        }
      }
      r.fail();
      expect(output(await run(r))).toMatchObject({ final: 'done' });
      // Natural core budget exhaustion aborts and disposes each Worker. Record
      // this separately from the same-Worker scope reset of injected failures.
      expect(f.counts.created).toBe(code === 'budget_exceeded' ? 7 : 1);
      expect(f.workerErrors).toEqual([]);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each([
  { gate: 'G4.1', options: { blocked: true }, code: 'denied', host: 0, provider: 1 },
  { gate: 'G4.2', options: { budget: 0 }, code: 'budget_exceeded', host: 0, provider: 1 },
  { gate: 'G4.4', options: { privateResult: true }, code: 'denied', host: 1, provider: 1 },
  {
    gate: 'G1.2 missing feature',
    options: { missingFeature: true },
    code: 'unavailable',
    host: 0,
    provider: 0,
  },
  {
    gate: 'G1.2 missing bindTools',
    options: { missingBind: true },
    code: 'unsupported',
    host: 0,
    provider: 0,
  },
])(
  '$gate through real core',
  async ({ options, code, host, provider }) => {
    const f = await fixture();
    const r = await runtimeInstance(f, options);
    try {
      await run(r, { handler: options.budget === 0 ? 'default' : 'boolean' });
      expect(r.instance.getSnapshot().run?.error?.code).toBe(code);
      expect(r.counts().attempts).toBe(host);
      expect(r.model.calls).toBe(provider);
      expect(r.counts().writes).toBe(0);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'G4.3: recursion budget stops an endless model/tool loop',
  async () => {
    const f = await fixture();
    const r = await runtimeInstance(f, { steps: 8 });
    try {
      await run(r, { endless: true });
      expect(r.instance.getSnapshot().run?.error?.code).toBe('budget_exceeded');
      expect(r.counts().attempts).toBeLessThanOrEqual(2);
      expect(r.model.calls).toBeLessThanOrEqual(3);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each(['approve', 'decline', 'cancel'] as const)(
  'G3.1/G3.2/G3.5: confirmation %s',
  async (decision) => {
    const f = await fixture();
    const r = await runtimeInstance(f);
    try {
      const { runId } = await r.instance.start({ scenario: 'write' });
      const events = collect(r.instance.events(runId));
      await expect.poll(() => r.instance.getSnapshot().confirmations?.length).toBe(1);
      const pending = r.instance.getSnapshot().confirmations?.[0];
      if (!pending) throw new Error('Missing confirmation.');
      expect(pending.arguments).toEqual({ value: 4 });
      expect(Object.isFrozen(pending.arguments)).toBe(true);
      expect(r.counts().writes).toBe(0);
      if (decision === 'cancel') await r.instance.cancel(runId);
      else r.instance.respond(pending.id, decision);
      const result = await events;
      if (decision === 'cancel') {
        expect(r.instance.getSnapshot().run?.status).toBe('cancelled');
        await expect
          .poll(() =>
            f.fromWorker
              .map((raw) => JSON.parse(raw))
              .some(
                (message) =>
                  message.op === 'result' &&
                  message.ok === false &&
                  message.error?.code === 'cancelled',
              ),
          )
          .toBe(true);
        expect(r.counts().writes).toBe(0);
      } else {
        expect(output(result)).toMatchObject({ final: 'done' });
        expect(r.counts().writes).toBe(decision === 'approve' ? 1 : 0);
        if (decision === 'decline')
          expect(JSON.stringify(output(result))).toContain('Policy denied the request.');
      }
      expect(r.instance.getSnapshot().confirmations ?? []).toHaveLength(0);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each(['none', 'unbound', 'uncovered'] as const)(
  'G3.3: refuse write binding %s',
  async (writeBinding) => {
    const f = await fixture();
    const r = await runtimeInstance(f, { writeBinding });
    try {
      await run(r, { scenario: 'write', handler: 'boolean', silent: true });
      expect(r.instance.getSnapshot().run?.error?.code).toBe('invalid');
      expect(r.counts().writes).toBe(0);
      expect(r.model.calls).toBe(1);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'G3.4: malformed schema arguments end invalid at the broker',
  async () => {
    const f = await fixture();
    const r = await runtimeInstance(f);
    try {
      await run(r, { scenario: 'bad-arguments', handler: 'callable', silent: true });
      expect(r.instance.getSnapshot().run?.error?.code).toBe('invalid');
      expect(r.counts().attempts).toBe(0);
      expect(requests(f, 'capability')).toHaveLength(1);
      expect(JSON.stringify(r.instance.getSnapshot().run?.error)).not.toContain('PRIVATE-MARKER');
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each([undefined, 'auto', 'none', 'required', 'read'])(
  'G1.1: ordered declarations and tool choice %s',
  async (choice) => {
    const f = await fixture();
    const r = await runtimeInstance(f);
    try {
      expect(output(await run(r, choice === undefined ? {} : { choice }))).toMatchObject({
        final: 'done',
      });
      const messages = requests(f, 'model') as {
        payload: { messages: unknown[]; options: { tools: unknown[]; toolChoice?: unknown } };
      }[];
      expect(messages[0]?.payload.options.tools).toEqual(
        ['read', 'write'].map((name) => ({
          type: 'function',
          function: {
            name,
            description: `${name[0]?.toUpperCase()}${name.slice(1)} a value.`,
            parameters: {
              type: 'object',
              properties: { value: { type: 'integer' } },
              required: ['value'],
            },
          },
        })),
      );
      expect(messages[0]?.payload.options.toolChoice).toEqual(
        choice === 'read' ? { type: 'function', function: { name: 'read' } } : choice,
      );
      expect(messages[1]?.payload.messages).toEqual([
        { role: 'user', content: 'read' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read', arguments: '{"value":2}' },
            },
          ],
        },
        { role: 'tool', content: '4', tool_call_id: 'call-1' },
      ]);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each([false, true])(
  'G5.3/G5.4: byte restore and receipts (node replay=%s)',
  async (replay) => {
    const f = await fixture();
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const first = await runtimeInstance(f, { store });
    let second: Awaited<ReturnType<typeof runtimeInstance>> | undefined;
    try {
      const { runId } = await first.instance.start({
        scenario: 'parallel-write',
        durable: true,
        replay,
      });
      const waiting = (async () => {
        for await (const event of first.instance.events(runId)) {
          if (event.type === 'error') throw new Error(`Unexpected failure: ${event.error.code}`);
          if (event.type === 'interaction') return;
        }
        throw new Error('Missing durable pause.');
      })();
      await expect.poll(() => first.instance.getSnapshot().confirmations?.length).toBe(1);
      const pending = first.instance.getSnapshot().confirmations?.[0];
      if (!pending) throw new Error('Missing confirmation.');
      first.instance.respond(pending.id, 'approve');
      await waiting;
      expect(first.counts().writes).toBe(1);
      expect(new Set(first.effects).size).toBe(2);
      const sessionId = first.instance.sessionId;
      await first.runtime.dispose();
      second = await runtimeInstance(f, { store, sessionId });
      const restored = await second.instance.restore();
      if (!restored) throw new Error('Missing restored run.');
      const interaction = second.instance.getSnapshot().run?.pending;
      if (!interaction) throw new Error('Missing restored interaction.');
      expect(
        await second.instance.dispatch({
          instanceId: second.instance.instanceId,
          runId: restored.runId,
          ...interaction,
          action: 'submit',
          payload: false,
        }),
      ).toMatchObject({ status: 'accepted' });
      expect(output(await collect(second.instance.events(restored.runId)))).toMatchObject({
        final: 'done',
      });
      expect(second.counts().writes).toBe(0);
      if (!replay) expect(second.counts().attempts).toBe(0);
      // Reads dispatch again and receive fresh IDs; only writes have receipts.
      else expect(second.effects).not.toEqual(first.effects.slice(0, 1));
      const capabilities = requests(f, 'capability') as { payload: { effectScope: string } }[];
      if (replay)
        expect(capabilities.slice(2).map((item) => item.payload.effectScope)).toEqual(
          capabilities.slice(0, 2).map((item) => item.payload.effectScope),
        );
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
  'G5.4: oversized tool result refuses without partial byte checkpoint',
  async () => {
    const f = await fixture();
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const r = await runtimeInstance(f, { store, oversized: true });
    try {
      await run(r, { handler: 'boolean' });
      expect(r.instance.getSnapshot().run?.error?.code).toBe('unsupported');
      expect(r.counts().attempts).toBe(1);
      expect(r.model.calls).toBe(1);
      expect(
        [...store.checkpoints.rows.values()].every(
          (row) => row.checkpoint.bytes.length < 1_048_576,
        ),
      ).toBe(true);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each([false, true])(
  'G1.3: native read-loop projection and counters (parallel=%s)',
  async (parallel) => {
    const reference = nativeReference(parallel);
    const f = await fixture();
    const r = await runtimeInstance(f);
    try {
      const actual = output(await run(r, { scenario: parallel ? 'parallel' : 'read' })) as {
        final: string;
        messages: unknown[];
      };
      expect({ final: actual.final, messages: actual.messages }).toEqual({
        final: reference.final,
        messages: reference.messages,
      });
      expect(r.calls).toEqual(reference.calls);
      expect(r.model.calls).toBe(reference.models);
      expect(r.counts().attempts).toBe(reference.tools);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'N3/G4.6: Worker scope mutation, early close, unscoped refusal and second session',
  async () => {
    const f = await fixture('tool_identity_probes');
    const first = await runtimeInstance(f);
    let second: Awaited<ReturnType<typeof runtimeInstance>> | undefined;
    try {
      for (let i = 0; i < 2; i++) {
        const actual = output(await run(first, { probe: 'lifetime' })) as {
          parent_id: number;
          nested_id: number;
        };
        expect(actual).toMatchObject({
          mutation_visible: true,
          early_close_reset: true,
          unscoped_refused: true,
        });
        expect(actual.nested_id).toBeGreaterThan(actual.parent_id);
      }
      expect(requests(f, 'model')).toEqual([]);
      expect(requests(f, 'capability')).toEqual([]);
      expect(f.counts.created).toBe(1);
      // A new runtime instance represents a different session. Each adapter prepare
      // owns an interpreter, so no public API can put it on the first Worker.
      second = await runtimeInstance(f);
      expect(second.instance.sessionId).not.toBe(first.instance.sessionId);
      expect(output(await run(second, { probe: 'lifetime' }))).toMatchObject({
        unscoped_refused: true,
      });
    } finally {
      await first.runtime.dispose();
      await second?.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'G1.5/G6: text behavior, streaming refusal and fixed refusal matrix',
  async () => {
    const f = await fixture('tool_identity_probes');
    const r = await runtimeInstance(f);
    try {
      for (const probe of ['text', 'text-stream'])
        expect(output(await run(r, { probe }))).toEqual({ final: 'done' });
      const cases = [
        ['plain', 'unsupported'],
        ['callable', 'unsupported'],
        ['dict', 'unsupported'],
        ['class', 'unsupported'],
        ['kwargs', 'unsupported'],
        ['choice', 'unsupported'],
        ['duplicate', 'invalid'],
        ['name', 'invalid'],
        ['oversized-schema', 'unsupported'],
        ['function-output', 'unsupported'],
        ['stream', 'unsupported'],
        ['unbound-history', 'unsupported'],
        ['human-block', 'unsupported'],
        ['ai-block', 'unsupported'],
        ['tool-block', 'unsupported'],
        ['artifact', 'unsupported'],
        ['error-status', 'unsupported'],
        ['orphan', 'invalid'],
      ];
      const before = {
        models: requests(f, 'model').length,
        tools: requests(f, 'capability').length,
      };
      for (const [probe, code] of cases) {
        await run(r, { probe });
        expect(r.instance.getSnapshot().run?.error?.code, probe).toBe(code);
        expect(JSON.stringify(r.instance.getSnapshot().run?.error)).not.toContain('PRIVATE-MARKER');
        expect(requests(f, 'model').length).toBe(before.models);
        expect(requests(f, 'capability').length).toBe(before.tools);
      }
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each(['array', 'json', 'duplicate', 'empty', 'unoffered'])(
  'G1.4: malformed reply %s through the real Worker',
  async (shape) => {
    const f = await fixture();
    const createWorker = f.options.createWorker;
    // Inject at the response boundary: MockChatModel deliberately refuses malformed
    // provider calls itself. Core and the adapter still execute normally.
    const injected = {
      ...f,
      options: {
        ...f.options,
        createWorker: () => {
          const port = createWorker();
          return {
            ...port,
            postMessage: (raw: string) => {
              const message = JSON.parse(raw);
              if (
                message.kind === 'response' &&
                message.op === 'model' &&
                message.ok &&
                message.payload.toolCalls?.length
              ) {
                const malformed = message.payload.toolCalls[0];
                if (shape === 'array') malformed.function.arguments = '[]';
                if (shape === 'json') malformed.function.arguments = '{';
                if (shape === 'duplicate')
                  message.payload.toolCalls.push(structuredClone(malformed));
                if (shape === 'empty') malformed.function.name = '';
                if (shape === 'unoffered') malformed.function.name = 'unoffered';
              }
              port.postMessage(JSON.stringify(message));
            },
          };
        },
      },
    };
    const r = await runtimeInstance(injected);
    try {
      await run(r);
      expect(r.instance.getSnapshot().run?.error?.code).toBe('invalid');
      expect(r.counts().attempts).toBe(0);
      expect(requests(f, 'capability')).toEqual([]);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'G4.7: observe a parked sibling write and checkpoint rows after latch',
  async () => {
    const f = await fixture();
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const r = await runtimeInstance(f, { store, failure: 'unavailable' });
    try {
      const { runId } = await r.instance.start({ scenario: 'parallel-write', handler: 'boolean' });
      const events = collect(r.instance.events(runId));
      await expect
        .poll(() => f.fromWorker.some((raw) => raw.includes('"latched":"unavailable"')))
        .toBe(true);
      await expect.poll(() => r.instance.getSnapshot().confirmations?.length).toBe(1);
      const pending = r.instance.getSnapshot().confirmations?.[0];
      if (!pending) throw new Error('Missing parked confirmation.');
      const rowsBefore = store.checkpoints.rows.size;
      expect(r.counts().writes).toBe(0);
      r.instance.respond(pending.id, 'approve');
      await events;
      // The sibling entered the broker before the latch, but host invocation can
      // still start after it. The experiment records this rather than claiming a
      // driver scope can cancel a confirmation already owned by JavaScript.
      expect(r.counts().writes).toBe(1);
      expect(store.checkpoints.rows.size).toBeGreaterThan(rowsBefore);
      console.info('G4.7 observations', {
        rowsBefore,
        rowsAfter: store.checkpoints.rows.size,
        hostWritesAfterLatch: r.counts().writes,
        capabilityRequests: requests(f, 'capability').length,
      });
      expect(r.instance.getSnapshot().run?.error?.code).toBe('unavailable');
      expect(r.model.calls).toBe(1);
      expect(requests(f, 'capability')).toHaveLength(2);
      r.fail();
      await run(r, null);
      expect(r.instance.getSnapshot().run?.error?.code).toBe('unsupported');
      expect(r.model.calls).toBe(1);
      expect(r.counts().writes).toBe(1);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'G5.2 FAIL: abrupt loss leaves a receipt but no public step-retry path',
  async () => {
    const f = await fixture();
    const held = Promise.withResolvers<void>();
    let intercepted = false;
    let armed = true;
    class CrashCheckpoints extends MemoryByteCheckpoints {
      override async request(value: unknown): Promise<unknown> {
        const request = parseByteRequest(value);
        if (
          armed &&
          request.op === 'put-writes' &&
          request.writes.some((write) =>
            new TextDecoder().decode(write.value.bytes).includes('saved'),
          )
        ) {
          intercepted = true;
          await held.promise;
          throw new GalaxieError('unavailable', 'Fixed crash fixture failure.');
        }
        return super.request(value);
      }
    }
    const store = { checkpoints: new CrashCheckpoints(), recovery: new MemoryRecoveryStore() };
    let kill: (() => void) | undefined;
    const configured = {
      ...f,
      options: {
        ...f.options,
        createWorker: () => {
          const port = f.options.createWorker();
          kill = () => port.terminate();
          return port;
        },
      },
    };
    const first = await runtimeInstance(configured, { store });
    let second: Awaited<ReturnType<typeof runtimeInstance>> | undefined;
    try {
      const { runId } = await first.instance.start({ scenario: 'write' });
      const events = collect(first.instance.events(runId));
      await expect.poll(() => first.instance.getSnapshot().confirmations?.length).toBe(1);
      const pending = first.instance.getSnapshot().confirmations?.[0];
      if (!pending) throw new Error('Missing write confirmation.');
      first.instance.respond(pending.id, 'approve');
      await expect.poll(() => intercepted, { timeout: 30_000 }).toBe(true);
      expect(first.counts().writes).toBe(1);
      expect(
        [...store.recovery.journal.values()].some((record) => record.status === 'succeeded'),
      ).toBe(true);
      if (!kill) throw new Error('Missing live Worker.');
      kill();
      held.resolve();
      const sessionId = first.instance.sessionId;
      await first.runtime.dispose();
      await events;
      armed = false;
      second = await runtimeInstance(f, { store, sessionId });
      // This is a failing recovery gate retained as a characterization: core only
      // restores pending interactions, and adopted sessions cannot start a new run.
      expect(await second.instance.restore()).toBeUndefined();
      await expect(second.instance.start(null)).rejects.toMatchObject({ code: 'invalid' });
      expect(second.counts().writes).toBe(0);
      expect(second.effects).toEqual([]);
      expect(f.counts.created).toBe(2);
    } finally {
      held.resolve();
      await first.runtime.dispose();
      await second?.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'G4.6: distinct real-core sessions share one prepared Worker sequentially',
  async () => {
    const f = await fixture();
    const adapter = createPyodideAdapter(f.options);
    let prepared: Awaited<ReturnType<typeof adapter.prepare>> | undefined;
    const shared: typeof adapter = {
      ...adapter,
      async prepare(agent, services, options) {
        prepared ??= await adapter.prepare(agent, services, options);
        return {
          ...prepared,
          // The test owns the one shared interpreter and disposes it after both cores.
          dispose: async () => {},
        };
      },
    };
    const first = await runtimeInstance(f, { adapter: shared, failure: 'unavailable' });
    let second: Awaited<ReturnType<typeof runtimeInstance>> | undefined;
    try {
      await run(first, { handler: 'callable', silent: true });
      expect(first.instance.getSnapshot().run?.error?.code).toBe('unavailable');
      second = await runtimeInstance(f, { adapter: shared, model: first.model });
      expect(second.instance.sessionId).not.toBe(first.instance.sessionId);
      expect(output(await run(second))).toMatchObject({ final: 'done' });
      expect(second.counts().attempts).toBe(1);
      expect(f.counts.created).toBe(1);
    } finally {
      await first.runtime.dispose();
      await second?.runtime.dispose();
      await prepared?.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable).each(['timeout', 'cancelled'] as const)(
  'G4.5: natural host %s under both handlers and endings',
  async (code) => {
    const f = await fixture();
    const r = await runtimeInstance(f, {
      hostTimeout: code === 'timeout',
      hostDelay: code === 'cancelled',
    });
    try {
      for (const handler of ['boolean', 'callable']) {
        for (const silent of [false, true]) {
          const before = { models: r.model.calls, attempts: r.counts().attempts };
          const { runId } = await r.instance.start({ handler, silent });
          const events = collect(r.instance.events(runId));
          if (code === 'cancelled') {
            await expect
              .poll(() => r.counts().attempts, { timeout: 30_000 })
              .toBeGreaterThan(before.attempts);
            await r.instance.cancel(runId);
          }
          await events;
          if (code === 'cancelled') expect(r.instance.getSnapshot().run?.status).toBe('cancelled');
          else expect(r.instance.getSnapshot().run?.error?.code).toBe('timeout');
          expect(r.model.calls - before.models).toBe(1);
          expect(r.counts().writes).toBe(0);
        }
      }
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'G5.1: two parallel writes keep distinct receipts across replay',
  async () => {
    const f = await fixture();
    const store = { checkpoints: new MemoryByteCheckpoints(), recovery: new MemoryRecoveryStore() };
    const first = await runtimeInstance(f, { store });
    let second: Awaited<ReturnType<typeof runtimeInstance>> | undefined;
    try {
      const { runId } = await first.instance.start({ scenario: 'two-writes', replay: true });
      const waiting = (async () => {
        for await (const event of first.instance.events(runId)) {
          if (event.type === 'error') throw new Error(event.error.code);
          if (event.type === 'interaction') return;
        }
        throw new Error('Missing replay pause.');
      })();
      await expect
        .poll(() => first.instance.getSnapshot().confirmations?.length, { timeout: 30_000 })
        .toBe(2);
      for (const pending of first.instance.getSnapshot().confirmations ?? [])
        first.instance.respond(pending.id, 'approve');
      await waiting;
      expect(first.counts().writes).toBe(2);
      expect(new Set(first.effects).size).toBe(2);
      const receipts = structuredClone([...store.recovery.journal]);
      expect(receipts).toHaveLength(2);
      expect(receipts.every(([, record]) => record.status === 'succeeded')).toBe(true);
      const sessionId = first.instance.sessionId;
      await first.runtime.dispose();
      second = await runtimeInstance(f, { store, sessionId });
      const restored = await second.instance.restore();
      const pending = second.instance.getSnapshot().run?.pending;
      if (!restored || !pending) throw new Error('Missing restored tool-node pause.');
      await second.instance.dispatch({
        instanceId: second.instance.instanceId,
        runId: restored.runId,
        ...pending,
        action: 'submit',
        payload: false,
      });
      expect(output(await collect(second.instance.events(restored.runId)))).toMatchObject({
        final: 'done',
      });
      expect(second.counts().writes).toBe(0);
      expect([...store.recovery.journal]).toEqual(receipts);
      const calls = requests(f, 'capability') as { payload: { effectScope: string } }[];
      expect(calls.slice(2).map((item) => item.payload.effectScope)).toEqual(
        calls.slice(0, 2).map((item) => item.payload.effectScope),
      );
    } finally {
      await first.runtime.dispose();
      await second?.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);

test.skipIf(!pythonWheelsAvailable)(
  'G4.8: hostile input never enters scope, errors or post-latch requests',
  async () => {
    const f = await fixture('tool_identity_probes');
    const r = await runtimeInstance(f);
    try {
      await run(r, { probe: 'hostile-latch' });
      expect(r.instance.getSnapshot().run?.error?.code).toBe('invalid');
      expect(JSON.stringify(r.instance.getSnapshot().run?.error)).not.toContain('PRIVATE-MARKER');
      expect(requests(f, 'model')).toEqual([]);
      expect(requests(f, 'capability')).toHaveLength(1);
      expect(r.counts().attempts).toBe(0);
    } finally {
      await r.runtime.dispose();
      await f.cleanup();
    }
  },
  timeout,
);
