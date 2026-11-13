// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type RunEvent,
  type RunId,
} from '@galaxie-ai/core';
import { LlmAgent, SequentialAgent } from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MemoryByteCheckpoints } from '../../../tests/conformance/support/memory-byte-checkpoints.js';
import { type AdkAgent, createAdkAdapter, defineAdkEntry } from '../src/index.js';
import { decodeRecord, pauseAuthor } from '../src/persist.js';
import { FakeChatModel, fakeModels, fakeTrace } from './support/fixtures.js';
import { withAuthor } from './support/with-author.js';

const runtimes: Array<{ dispose(): Promise<void> }> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});
const routing: ModelRouting = {
  providers: {
    mock: {
      destination: 'in-browser',
      modality: 'text',
      languages: ['en'],
      features: ['tool-calling'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { agent: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
};
const definition = defineAgentDefinition({
  id: 'tests/adk-pause-author',
  version: '1.0.0',
  executor: 'adk-js',
  input: z.object({ prompt: z.string() }),
  models: { agent: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'docs.save@1': {
        kind: 'write',
        input: z.object({ q: z.string() }),
        output: z.object({ saved: z.string() }),
      },
    },
  },
});
type Shape = 'solo' | 'long' | 'first' | 'transfer' | 'two';
const save = {
  description: 'Save a note.',
  parameters: z.object({ q: z.string() }),
  requireConfirmation: true,
};

function factory(shape: Shape): AdkAgent {
  return (host) => {
    const leaf = new LlmAgent({
      name: 'agent',
      model: host.adk.llm('agent'),
      instruction: 'role=agent;',
      tools: [
        host.adk.capabilityTool(
          'docs.save@1',
          shape === 'long'
            ? { description: save.description, parameters: save.parameters, longRunning: true }
            : save,
        ),
      ],
    });
    const root =
      shape === 'first'
        ? new SequentialAgent({
            name: 'flow',
            subAgents: [
              leaf,
              new LlmAgent({
                name: 'later',
                model: host.adk.llm('agent'),
                instruction: 'role=later;',
              }),
            ],
          })
        : shape === 'transfer'
          ? new LlmAgent({
              name: 'parent',
              model: host.adk.llm('agent'),
              instruction: 'role=parent;',
              subAgents: [leaf],
            })
          : leaf;
    return defineAdkEntry({
      agent: root,
      interaction: (requests) => ({
        surfaceId: 'main',
        viewRevision: 'r1',
        component: 'tests.Approval/v1',
        props: { count: requests.length },
      }),
      ...(shape === 'long' ? { resume: () => [{ response: { saved: 'external' } }] } : {}),
    });
  };
}

async function life(shape: Shape) {
  const bytes = new MemoryByteCheckpoints();
  const writes: string[] = [];
  let fresh = false;
  const model = new FakeChatModel((seen) => {
    if (fresh) return new AIMessage({ content: 'fresh' });
    if (JSON.stringify(seen.messages[0]?.content).includes('role=parent;'))
      return new AIMessage({
        content: '',
        tool_calls: [{ id: 'transfer', name: 'transfer_to_agent', args: { agent_name: 'agent' } }],
      });
    return new AIMessage({
      content: '',
      tool_calls: Array.from({ length: shape === 'two' ? 2 : 1 }, (_, index) => ({
        id: `call_${index}`,
        name: 'docs_save_1',
        args: { q: `note_${index}` },
      })),
    });
  });
  const runtime = createRuntime({
    appId: 'adk-pause-author',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
  });
  runtimes.push(runtime);
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent: factory(shape),
    models: routing,
    services: { chatModels: { mock: model }, checkpoints: bytes },
    confirmations: { capabilities: ['docs.save@1'], policyRevision: () => 'v1' },
    bindings: {
      'docs.save@1': {
        kind: 'write',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 2,
        grantScope: 'instance',
        approval: 'confirm',
        retry: 'none',
        async invoke(input: { q: string }) {
          writes.push(input.q);
          return { saved: input.q };
        },
      },
    },
  });
  await instance.prepare();
  const timer = setInterval(() => {
    for (const pending of instance.getSnapshot().confirmations ?? [])
      instance.respond(pending.id, 'approve');
  }, 5);
  return {
    runtime,
    instance,
    model,
    bytes,
    writes,
    fresh() {
      fresh = true;
    },
    async close() {
      clearInterval(timer);
      await runtime.dispose();
    },
  };
}
type Life = Awaited<ReturnType<typeof life>>;
async function segment(l: Life): Promise<RunEvent[]> {
  const run = l.instance.getSnapshot().run;
  if (run === undefined) throw new Error('Missing run.');
  const events: RunEvent[] = [];
  for await (const event of l.instance.events(run.runId)) {
    events.push(event);
    if (event.type === 'interaction') break;
  }
  return events;
}

test.each<Shape>(['solo', 'long', 'first', 'transfer', 'two'])(
  '%s derives the live author from the same stored calls as restore',
  async (shape) => {
    const l = await life(shape);
    try {
      await l.instance.start({ prompt: 'go' });
      const events = await segment(l);
      expect(events.filter((event) => event.type === 'interaction')).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: 'interaction',
        interaction: { props: { count: shape === 'two' ? 2 : 1 } },
      });
      const row = await l.bytes.request({
        op: 'get',
        executor: 'adk-js',
        sessionId: l.instance.sessionId,
        namespace: '',
      });
      const stored = await decodeRecord(
        l.instance.sessionId,
        async () => {
          const b = new TextEncoder().encode(JSON.stringify([l.instance.sessionId, 0]));
          return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (v) =>
            v.toString(16).padStart(2, '0'),
          ).join('');
        },
        row as Parameters<typeof decodeRecord>[2],
      );
      expect(pauseAuthor(stored.pause?.calls ?? [], stored.events)).toBe('agent');
    } finally {
      await l.close();
    }
  },
);

test.each([
  {
    name: 'confirmation request',
    shape: 'solo',
    tool: 'adk_request_confirmation',
    author: undefined,
  },
  { name: 'gated call', shape: 'solo', tool: 'docs_save_1', author: undefined },
  { name: 'long-running call', shape: 'long', tool: 'docs_save_1', author: undefined },
  { name: 'mixed-author multi-call turn', shape: 'two', tool: 'docs_save_1', author: 'other' },
] as const)(
  '$name refuses a missing or disagreeing stored author and rolls back',
  async ({ shape, tool, author }) => {
    const l = await life(shape);
    try {
      await withAuthor(
        (event) => (event.content?.parts ?? []).some((part) => part.functionCall?.name === tool),
        author,
        async () => {
          await l.instance.start({ prompt: 'rejected-prompt' });
          const events = await segment(l);
          expect(events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
          expect(events.some((event) => event.type === 'interaction')).toBe(false);
        },
      );
      const before = [...l.writes];
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(l.writes).toEqual(before);
      expect(l.writes).toEqual(shape === 'long' ? ['note_0'] : []);
      expect([...l.bytes.rows]).toEqual([]);
      const prior = l.model.seen.length;
      l.fresh();
      await l.instance.start({ prompt: 'fresh-prompt' });
      expect((await segment(l)).at(-1)).toMatchObject({ type: 'output', output: 'fresh' });
      const humans = l.model.seen
        .slice(prior)
        .flatMap((call) =>
          call.messages
            .filter((message) => message.type === 'human')
            .map((message) => message.content),
        );
      expect(humans).not.toContain('rejected-prompt');
      expect(humans).toContain('fresh-prompt');
    } finally {
      await l.close();
    }
  },
);

test('a rejected session refuses pending repeatedly and start without registration or calls', async () => {
  const l = await life('solo');
  await l.instance.start({ prompt: 'go' });
  expect((await segment(l)).at(-1)?.type).toBe('interaction');
  await l.close();
  const before = structuredClone([...l.bytes.rows]);
  const model = new FakeChatModel(() => new AIMessage({ content: 'unexpected' }));
  const changed: AdkAgent = (host) =>
    defineAdkEntry({
      agent: new SequentialAgent({
        name: 'flow',
        subAgents: ['earlier', 'agent', 'later'].map(
          (name) =>
            new LlmAgent({
              name,
              model: host.adk.llm('agent'),
              tools: [host.adk.capabilityTool('docs.save@1', save)],
            }),
        ),
      }),
      interaction: () => ({
        surfaceId: 'main',
        viewRevision: 'r1',
        component: 'tests.Approval/v1',
        props: {},
      }),
    });
  const prepared = await createAdkAdapter().prepare(
    changed,
    { chatModels: { mock: model }, checkpoints: l.bytes },
    {
      signal: new AbortController().signal,
      models: { roles: ['agent'], providers: { mock: { credential: false } } },
    },
  );
  const registerRestoredData = vi.fn();
  const call = vi.fn();
  try {
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(
        prepared.pending?.(l.instance.sessionId, { registerRestoredData }),
      ).rejects.toMatchObject({ code: 'unrecoverable' });
    const events = [];
    for await (const event of prepared.run({
      runId: 'rejected-start' as RunId,
      sessionId: l.instance.sessionId,
      command: { type: 'start', input: { prompt: 'new' } },
      signal: new AbortController().signal,
      models: fakeModels().port,
      trace: fakeTrace().trace,
      capabilities: { call },
      limits: { steps: 5 },
      registerRestoredData,
    }))
      events.push(event);
    expect(events).toEqual([
      { type: 'error', error: expect.objectContaining({ code: 'unrecoverable' }) },
    ]);
    expect(registerRestoredData).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
    expect(model.seen).toEqual([]);
    expect([...l.bytes.rows]).toEqual(before);
  } finally {
    await prepared.dispose();
  }
});
