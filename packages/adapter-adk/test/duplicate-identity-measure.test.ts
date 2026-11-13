// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/adk-env.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type RunEvent,
  type SessionId,
} from '@galaxie-ai/core';
import {
  type BaseAgent,
  type Event,
  isFinalResponse,
  LlmAgent,
  LoopAgent,
  ParallelAgent,
  SequentialAgent,
} from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { MemoryByteCheckpoints } from '../../../tests/conformance/support/memory-byte-checkpoints.js';
import { createAdkAdapter } from '../src/adapter.js';
import type { AdkHost } from '../src/host.js';
import { defineAdkEntry } from '../src/interaction.js';
import { FakeChatModel, wordChunks } from './support/fixtures.js';

/* Repeated agent names refuse at prepare; unique names keep their recipes.
 * Executed here: RF2/RF5 duplicate refusal before model/store access and malformed-child
 * precedence; RF4 unique-pause restore bytes and refusal before duplicate-tree restore;
 * RF5/RF6 exact distinct names and limit trees; GA1/GA2/GA4/GA5 unique-name recipes
 * across runs and rebuilt trees. Each claim maps to the identically labelled tests below.
 * Measured before the refusal shipped, when duplicate trees still prepared, and not
 * executed in this file: DA1 FAIL (native Sequential/Loop fields collide); DA2 FAIL S5
 * (partial-only first worker missing from the stored log, DC1 attributes second/first/second
 * to first/second/first); S1-S3 and ordinary two-turn baseline PASS; DA3 PASS S4
 * (rebuilt pause log and live derivation agree); DA4 first-match output-key loss,
 * Python Parallel surrogate-buffer mixing and the failed native transfer prediction.
 * See ADR-0020, "Duplicate-identity measured outcome", for D-js REFUSED and this history.
 * Native probes remain in packages/adapter-adk/test/duplicate-identity-native.test.ts
 * and tests/conformance/cases-adk-python/test_adk_python_duplicate_identity.py.
 * S6-S8 not measured: outcome fixed by S5. GA6/GA8 not measured: carriage not shipped.
 * GF1-GF5 not measured: outcome fixed by GF2.
 * No public path, stored format or effect scope changes.
 */
const definition = defineAgentDefinition({
  id: 'tests/adk-duplicate-identity',
  version: '1.0.0',
  executor: 'adk-js',
  input: z.object({ prompt: z.string() }),
  models: { agent: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'test.echo@1': { kind: 'read', input: z.object({}), output: z.object({ text: z.string() }) },
    },
  },
});
const routing: ModelRouting = {
  providers: {
    mock: {
      destination: 'in-browser',
      modality: 'text',
      languages: ['en'],
      features: ['streaming', 'tool-calling', 'structured-output'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { agent: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
};

function pathsOf(root: BaseAgent): Map<string, string[][]> {
  const paths = new Map<string, string[][]>();
  const visit = (agent: BaseAgent, path: string[]): void => {
    paths.set(agent.name, [...(paths.get(agent.name) ?? []), path]);
    for (const child of agent.subAgents) visit(child, [...path, child.name]);
  };
  visit(root, []);
  return paths;
}

/** Registered DC1: completed runs per author/branch over the complete event log. */
function derive(events: readonly Event[], root: BaseAgent): string[][] {
  const paths = pathsOf(root);
  const counts = new Map<string, number>();
  return events.flatMap((event) => {
    if (event.content?.role !== 'model' || !event.author) return [];
    const positions = paths.get(event.author) ?? [];
    const candidates = event.branch
      ? positions.filter((path) => event.branch === `root.${path[0]}`)
      : positions;
    const key = JSON.stringify([event.author, event.branch ?? '']);
    const count = counts.get(key) ?? 0;
    const path = candidates[count % candidates.length];
    if (!event.partial && isFinalResponse(event)) counts.set(key, count + 1);
    if (!path) throw new Error('No candidate position.');
    return [path];
  });
}

interface Options {
  tools?: boolean;
  pause?: boolean;
  output?: boolean;
  bytes?: MemoryByteCheckpoints;
  sessionId?: SessionId;
}

async function life(shape = 'sequential', options: Options = {}) {
  const bytes = options.bytes ?? new MemoryByteCheckpoints();
  const requests: string[] = [];
  const turns = new Map<string, number>();
  let storeRequests = 0;
  const model = new FakeChatModel(
    (seen) => {
      const tag = /tag:(\w+)/.exec(seen.messages[0]?.text ?? '')?.[1];
      if (!tag) throw new Error('Missing scripted position.');
      requests.push(tag);
      const turn = turns.get(tag) ?? 0;
      turns.set(tag, turn + 1);
      const tools = seen.messages.filter((message) => message.type === 'tool');
      if (tag === 'router')
        return new AIMessage({
          content: '',
          tool_calls: [
            { id: 'transfer', name: 'transfer_to_agent', args: { agent_name: 'specialist' } },
          ],
        });
      if (
        (options.tools && turn === 0) ||
        (tag === 'gate' && !tools.some((message) => message.name === 'echo'))
      )
        return new AIMessage({
          content: '',
          tool_calls: [{ id: `call-${tag}`, name: 'echo', args: {} }],
        });
      return new AIMessage({ content: options.output ? `{"position":"${tag}"}` : tag });
    },
    undefined,
    wordChunks,
  );
  const runtime = createRuntime({
    appId: 'duplicate-identity',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: 600, tokens: 100000 },
  });
  let root: BaseAgent | undefined;
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    models: routing,
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    services: {
      chatModels: { mock: model },
      checkpoints: {
        request: async (value: unknown) => {
          storeRequests++;
          return bytes.request(value);
        },
      },
    },
    bindings: {
      'test.echo@1': {
        kind: 'read',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 2,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke() {
          return { text: 'content-canary' };
        },
      },
    },
    agent: (host: AdkHost) => {
      const leaf = (name: string, tag = name): LlmAgent => {
        const model = host.adk.llm('agent');
        return new LlmAgent({
          name,
          model,
          instruction: `tag:${tag}`,
          ...(options.output
            ? { outputKey: `${tag}_key`, outputSchema: z.object({ position: z.string() }) }
            : {}),
          tools:
            options.tools || tag === 'gate'
              ? [
                  host.adk.capabilityTool('test.echo@1', {
                    toolName: 'echo',
                    description: 'Echo.',
                    parameters: z.object({}),
                    ...(tag === 'gate' ? { requireConfirmation: true } : {}),
                  }),
                ]
              : [],
        });
      };
      const branches = ['first', 'second'].map(
        (name) =>
          new SequentialAgent({
            name,
            subAgents: [leaf(shape === 'transfer' ? 'specialist' : 'worker', name)],
          }),
      );
      if (shape === 'unique-sequential')
        root = new SequentialAgent({
          name: 'root',
          subAgents: [leaf('drafter'), leaf('reviewer')],
        });
      else if (shape === 'unique-parallel')
        root = new ParallelAgent({ name: 'root', subAgents: [leaf('left'), leaf('right')] });
      else if (shape === 'unique-nested')
        root = new ParallelAgent({
          name: 'root',
          subAgents: [
            new SequentialAgent({ name: 'sequence', subAgents: [leaf('a'), leaf('b')] }),
            leaf('c'),
          ],
        });
      else if (shape === 'unique-loop')
        root = new LoopAgent({ name: 'root', maxIterations: 2, subAgents: [leaf('worker')] });
      else if (shape === 'unique-transfer')
        root = new LlmAgent({
          name: 'root',
          model: host.adk.llm('agent'),
          instruction: 'tag:router',
          subAgents: [leaf('specialist')],
        });
      else if (shape === 'unique-pause')
        root = new SequentialAgent({ name: 'root', subAgents: [leaf('gate'), leaf('tail')] });
      else if (shape === 'parallel')
        root = new ParallelAgent({ name: 'root', subAgents: branches });
      else if (shape === 'loop')
        root = new LoopAgent({ name: 'root', maxIterations: 2, subAgents: branches });
      else if (shape === 'transfer')
        root = new LlmAgent({
          name: 'root',
          model: host.adk.llm('agent'),
          instruction: 'tag:router',
          subAgents: branches,
        });
      else
        root = new SequentialAgent({
          name: 'root',
          subAgents: options.pause ? [leaf('gate'), ...branches] : branches,
        });
      if (shape === 'root-duplicate')
        root = new SequentialAgent({ name: 'worker', subAgents: [leaf('worker')] });
      if (shape === 'shared') {
        const shared = leaf('worker');
        const first = new SequentialAgent({ name: 'first', subAgents: [shared] });
        const second = new SequentialAgent({ name: 'second', subAgents: [] });
        second.subAgents.push(shared);
        root = new SequentialAgent({ name: 'root', subAgents: [first, second] });
      }
      if (shape === 'malformed') {
        const bad = leaf('bad');
        Reflect.set(bad, 'subAgents', {});
        root.subAgents.push(bad);
      }
      if (shape === 'distinct')
        root = new SequentialAgent({
          name: 'root',
          subAgents: ['Worker', 'worker', '\u00e9', 'e\u0301'].map((name, index) =>
            leaf(name, `name${index}`),
          ),
        });
      if (shape === 'size-limit')
        root = new SequentialAgent({
          name: 'root',
          subAgents: Array.from({ length: 255 }, (_, index) => leaf(`leaf${index}`)),
        });
      if (shape === 'depth-limit') {
        root = leaf('bottom');
        for (let depth = 15; depth >= 0; depth--)
          root = new SequentialAgent({ name: `level${depth}`, subAgents: [root] });
      }
      return defineAdkEntry({
        agent: root,
        interaction: () => ({
          surfaceId: 'main',
          viewRevision: 'r1',
          component: 'tests.Approval/v1',
          props: {},
        }),
      });
    },
  });
  const segment = async (resume = false): Promise<RunEvent[]> => {
    if (resume) {
      const run = instance.getSnapshot().run;
      if (!run?.pending) throw new Error('Missing pause.');
      const receipt = await instance.dispatch({
        instanceId: instance.instanceId,
        runId: run.runId,
        ...run.pending,
        action: 'approve',
        payload: { indexes: [0] },
      });
      expect(receipt.status).toBe('accepted');
    } else await instance.start({ prompt: 'content-canary' });
    const runId = instance.getSnapshot().run?.runId;
    if (!runId) throw new Error('Missing run.');
    const events: RunEvent[] = [];
    for await (const event of instance.events(runId)) {
      events.push(event);
      if (
        event.type === 'interaction' &&
        instance.getSnapshot().run?.pending?.interactionId === event.interaction.interactionId
      )
        break;
    }
    return events;
  };
  const stored = (): Event[] => {
    const row = [...bytes.rows.values()].at(-1);
    if (!row) throw new Error('No stored record.');
    return (JSON.parse(new TextDecoder().decode(row.checkpoint.bytes)) as { events: Event[] })
      .events;
  };
  return {
    instance,
    runtime,
    bytes,
    requests,
    segment,
    stored,
    get root() {
      if (!root) throw new Error('Not prepared.');
      return root;
    },
    get storeRequests() {
      return storeRequests;
    },
  };
}

for (const shape of [
  'sequential',
  'parallel',
  'loop',
  'transfer',
  'root-duplicate',
  'shared',
  'tools',
  'output',
  'pause',
]) {
  test(`RF2/RF5: ${shape} duplicates fail at prepare before model or store access`, async () => {
    const l = await life(shape, {
      tools: shape === 'tools',
      output: shape === 'output',
      pause: shape === 'pause',
    });
    try {
      await expect(l.instance.prepare()).rejects.toMatchObject({
        code: 'unsupported',
        message: 'This operation is unsupported.',
      });
      expect(l.requests).toEqual([]);
      expect(l.storeRequests).toBe(0);
      expect(l.bytes.rows.size).toBe(0);
    } finally {
      await l.runtime.dispose();
    }
  });
}

for (const [shape, oracle] of [
  ['unique-sequential', [['drafter'], ['reviewer']]],
  ['unique-parallel', [['left'], ['right']]],
  ['unique-nested', [['sequence', 'a'], ['sequence', 'b'], ['c']]],
  ['unique-loop', [['worker'], ['worker']]],
  ['unique-transfer', [['specialist']]],
] as const) {
  test(`GA1/GA2/GA4/GA5: ${shape} recipe survives runs and rebuilt trees`, async () => {
    for (let rebuild = 0; rebuild < 2; rebuild++) {
      const l = await life(shape);
      try {
        await l.instance.prepare();
        for (let turn = 0; turn < 2; turn++) {
          const events = await l.segment();
          expect(events.at(-1)?.type).toBe('output');
          const expected = Array.from({ length: turn + 1 }, () => [...oracle]).flat();
          expect(derive(l.stored().filter(isFinalResponse), l.root).sort()).toEqual(
            expected.sort(),
          );
          for (const event of events)
            if (event.type === 'stream') {
              expect(event.path).toEqual([]);
              if (event.mode === 'messages') {
                const author = (event.data as { author: string }).author;
                const positions = pathsOf(l.root).get(author);
                expect(positions).toHaveLength(1);
                expect(positions?.[0]?.length).toBeLessThanOrEqual(16);
                expect(JSON.stringify(positions)).not.toContain('content-canary');
              }
            }
        }
        expect(createAdkAdapter().features.subgraphs).toBe(false);
      } finally {
        await l.runtime.dispose();
      }
    }
  });
}

test('RF4: unique pause bytes restore unchanged; a duplicate tree fails before reading them', async () => {
  let l = await life('unique-pause');
  try {
    await l.instance.prepare();
    expect((await l.segment()).some((event) => event.type === 'interaction')).toBe(true);
    const before = structuredClone([...l.bytes.rows]);
    const bytes = l.bytes;
    const sessionId = l.instance.sessionId;
    const pending = l.instance.getSnapshot().run?.pending;
    await l.runtime.dispose();
    l = await life('unique-pause', { bytes, sessionId });
    await l.instance.prepare();
    await l.instance.restore();
    expect(l.instance.getSnapshot().run?.pending).toEqual(pending);
    expect([...bytes.rows]).toEqual(before);
    expect((await l.segment(true)).at(-1)?.type).toBe('output');
    await l.runtime.dispose();
    const pausedBytes = new MemoryByteCheckpoints();
    for (const [key, row] of before) pausedBytes.rows.set(key, row);
    l = await life('sequential', { pause: true, bytes: pausedBytes, sessionId });
    await expect(l.instance.prepare()).rejects.toMatchObject({ code: 'unsupported' });
    expect(l.requests).toEqual([]);
    expect(l.storeRequests).toBe(0);
    expect([...pausedBytes.rows]).toEqual(before);
    expect(l.instance.getSnapshot().run?.pending).toBeUndefined();
  } finally {
    await l.runtime.dispose();
  }
});

for (const shape of ['distinct', 'depth-limit', 'size-limit']) {
  test(`RF5/RF6: ${shape} runs with exactly one path per name`, async () => {
    const l = await life(shape);
    try {
      await l.instance.prepare();
      for (const positions of pathsOf(l.root).values()) expect(positions).toHaveLength(1);
      expect((await l.segment()).at(-1)?.type).toBe('output');
      expect(l.requests.length).toBe(shape === 'size-limit' ? 255 : shape === 'distinct' ? 4 : 1);
    } finally {
      await l.runtime.dispose();
    }
  });
}

test('RF2: a later malformed child keeps invalid precedence over duplicate names', async () => {
  const l = await life('malformed');
  try {
    await expect(l.instance.prepare()).rejects.toMatchObject({ code: 'invalid' });
    expect(l.requests).toEqual([]);
    expect(l.storeRequests).toBe(0);
  } finally {
    await l.runtime.dispose();
  }
});
