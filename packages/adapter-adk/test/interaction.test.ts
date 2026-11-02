// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import './support/adk-env.js';
import './support/bundle-csp/record-spans.js';
import {
  createRuntime,
  defineAgentDefinition,
  type ExecutorAdapter,
  type ModelRouting,
  type PendingInteraction,
  parseInteractionRequest,
  type RunEvent,
} from '@galaxie/core';
import {
  BaseLlm,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
  ParallelAgent,
  Runner,
} from '@google/adk';
import { AIMessage } from '@langchain/core/messages';
import { afterAll, expect, test } from 'vitest';
import { z } from 'zod';
import { createAdkAdapter } from '../src/adapter.js';
import type { AdkAgent } from '../src/host.js';
import { ADK_EXECUTOR_ID } from '../src/index.js';
import {
  type AdkDecision,
  type AdkPendingRequest,
  defineAdkEntry,
  PauseTracker,
} from '../src/interaction.js';
import { GalaxieSessionService } from '../src/session.js';
import type { SpanRecorder } from './support/bundle-csp/span-recorder.js';
import { FakeChatModel, type Reply } from './support/fixtures.js';

const recorder = Reflect.get(globalThis, 'adkSpanRecorder') as SpanRecorder;
afterAll(() => recorder.dispose());

const routing: ModelRouting = {
  providers: {
    mock: {
      destination: 'in-browser',
      modality: 'text',
      languages: ['en'],
      features: ['tool-calling', 'structured-output'],
      pricing: { inputPerToken: 0, outputPerToken: 0 },
    },
  },
  roles: { agent: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
};

const definition = defineAgentDefinition({
  id: 'tests/adk-interactions',
  version: '1.0.0',
  executor: ADK_EXECUTOR_ID,
  input: z.object({ prompt: z.string() }),
  models: { agent: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'docs.search@1': {
        kind: 'read',
        input: z.object({ q: z.string() }),
        output: z.object({ hit: z.string() }),
      },
    },
  },
});

const search = { description: 'Search the documents.', parameters: z.object({ q: z.string() }) };
const gate = { ...search, requireConfirmation: true };
const toolCall = (q: string, id = 'call_0') => ({ id, name: 'docs_search_1', args: { q } });
const request = (count: number): unknown => ({
  surfaceId: 'main',
  viewRevision: 'r1',
  component: 'tests.Approval/v1',
  props: { count },
});

/** Calls the tool once while no tool message exists, then answers with the final text. */
const once =
  (...queries: string[]): Reply =>
  (seen) =>
    seen.messages.some((message) => message.type === 'tool')
      ? new AIMessage({ content: 'finished' })
      : new AIMessage({
          content: '',
          tool_calls: queries.map((q, index) => toolCall(q, `call_${index}`)),
        });

interface Options {
  readonly reply: Reply;
  readonly agent: AdkAgent;
}

async function setup({ reply, agent }: Options) {
  const model = new FakeChatModel(reply);
  const invocations: { q: string }[] = [];
  const runtime = createRuntime({
    appId: 'adk-interaction-tests',
    executors: [createAdkAdapter() as ExecutorAdapter<unknown, unknown>],
    budgets: { steps: 8, toolCalls: 10, tokens: 5000 },
  });
  const instance = await runtime.create(definition, {
    principalScope: 'user',
    agent,
    services: { chatModels: { mock: model } },
    bindings: {
      'docs.search@1': {
        kind: 'read',
        destination: 'in-browser',
        timeoutMs: 1000,
        concurrency: 2,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke(input: { q: string }) {
          invocations.push(input);
          return { hit: `hit:${input.q}` };
        },
      },
    },
    models: routing,
  });
  await instance.prepare();
  const { runId } = await instance.start({ prompt: 'go' });
  const events: RunEvent[] = [];
  const settled = async (): Promise<void> => {
    events.length = 0;
    for await (const event of instance.events(runId)) {
      events.push(event);
      if (event.type === 'interaction') {
        const next = events.filter((e) => e.type === 'interaction').length;
        if (next > answered) return;
      }
    }
  };
  let answered = 0;
  await settled();
  const pending = (): PendingInteraction => {
    const found = events.filter((event) => event.type === 'interaction').at(-1);
    if (found?.type !== 'interaction') throw new Error('no pending interaction');
    return found.interaction;
  };
  const answer = async (action: string, payload: unknown, from = pending()) => {
    const receipt = await instance.dispatch({
      instanceId: instance.instanceId,
      runId,
      ...from,
      action,
      payload,
    });
    if (receipt.status === 'accepted') answered += 1;
    return receipt;
  };
  const next = async (): Promise<void> => {
    await settled();
  };
  return { runtime, instance, model, invocations, events, pending, answer, next };
}

const last = (events: readonly RunEvent[]): RunEvent | undefined => events.at(-1);
const interactionsOf = (events: readonly RunEvent[]): PendingInteraction[] =>
  events.flatMap((event) => (event.type === 'interaction' ? [event.interaction] : []));

const confirming = (
  seen: AdkPendingRequest[][],
  resume?: (
    requests: readonly AdkPendingRequest[],
    action: string,
    payload: unknown,
  ) => readonly AdkDecision[],
): AdkAgent => {
  return (host) =>
    defineAdkEntry({
      agent: new LlmAgent({
        name: 'agent',
        model: host.adk.llm('agent'),
        instruction: 'Answer briefly.',
        tools: [host.adk.capabilityTool('docs.search@1', gate)],
      }),
      interaction: (requests) => {
        seen.push([...requests]);
        return request(requests.length);
      },
      ...(resume === undefined ? {} : { resume }),
    });
};

async function finish(harness: Awaited<ReturnType<typeof setup>>): Promise<RunEvent[]> {
  const { instance, events } = harness;
  const runId = (events[0] as RunEvent).runId;
  const all: RunEvent[] = [];
  for await (const event of instance.events(runId)) all.push(event);
  return all;
}

test('a confirmation pauses the run with one valid interaction and the tool has not run', async () => {
  const seen: AdkPendingRequest[][] = [];
  const harness = await setup({ reply: once('x'), agent: confirming(seen) });
  expect(last(harness.events)).toMatchObject({ type: 'interaction' });
  const { interactionId, ...shown } = harness.pending();
  expect(interactionId).toMatch(/^[0-9a-f]{64}$/);
  expect(parseInteractionRequest(shown)).toEqual(shown);
  expect(harness.invocations).toHaveLength(0);
  expect(seen).toEqual([[{ kind: 'confirmation', tool: 'docs_search_1', args: { q: 'x' } }]]);
  expect(harness.events.some((event) => event.type === 'stream' && event.mode === 'updates')).toBe(
    true,
  );
  expect(harness.events.some((event) => event.type === 'output')).toBe(false);
  await harness.runtime.dispose();
});

test('approving runs the tool exactly once and the run completes', async () => {
  const harness = await setup({ reply: once('x'), agent: confirming([]) });
  const receipt = await harness.answer('approve', { indexes: [0] });
  expect(receipt.status).toBe('accepted');
  const events = await finish(harness);
  expect(harness.invocations).toEqual([{ q: 'x' }]);
  expect(last(events)).toMatchObject({ type: 'output', output: 'finished' });
  await harness.runtime.dispose();
});

test('denying reports the denial to the model without running the tool', async () => {
  const harness = await setup({ reply: once('x'), agent: confirming([]) });
  await harness.answer('deny', { indexes: [0] });
  const events = await finish(harness);
  expect(harness.invocations).toHaveLength(0);
  expect(last(events)).toMatchObject({ type: 'output', output: 'finished' });
  await harness.runtime.dispose();
});

test('a double submit resumes the run once', async () => {
  const harness = await setup({ reply: once('x'), agent: confirming([]) });
  const from = harness.pending();
  const [first, second] = await Promise.all([
    harness.answer('approve', { indexes: [0] }, from),
    harness.answer('approve', { indexes: [0] }, from),
  ]);
  expect([first.status, second.status].sort()).toEqual(['accepted', 'rejected']);
  await finish(harness);
  expect(harness.invocations).toHaveLength(1);
  await harness.runtime.dispose();
});

test('two confirmations in one model response form one interaction decided per request', async () => {
  const seen: AdkPendingRequest[][] = [];
  const harness = await setup({
    reply: once('a', 'b'),
    agent: confirming(seen, (requests, _action, payload) => {
      const approved = (payload as { approve: number[] }).approve;
      return requests.map((_, index) => ({ confirmed: approved.includes(index) }));
    }),
  });
  expect(interactionsOf(harness.events)).toHaveLength(1);
  expect(seen[0]?.map((entry) => (entry.kind === 'confirmation' ? entry.args : {}))).toEqual([
    { q: 'a' },
    { q: 'b' },
  ]);
  await harness.answer('decide', { approve: [1] });
  const events = await finish(harness);
  expect(harness.invocations).toEqual([{ q: 'b' }]);
  expect(last(events)).toMatchObject({ type: 'output' });
  await harness.runtime.dispose();
});

test('consecutive pauses carry distinct interaction IDs', async () => {
  const harness = await setup({
    reply: (seen) => {
      const tools = seen.messages.filter((message) => message.type === 'tool').length;
      return tools >= 2
        ? new AIMessage({ content: 'finished' })
        : new AIMessage({ content: '', tool_calls: [toolCall(`q${tools}`)] });
    },
    agent: confirming([]),
  });
  const first = harness.pending();
  await harness.answer('approve', { indexes: [0] });
  await harness.next();
  const second = harness.pending();
  expect(second.interactionId).not.toBe(first.interactionId);
  await harness.answer('approve', { indexes: [0] }, second);
  const events = await finish(harness);
  expect(harness.invocations).toEqual([{ q: 'q0' }, { q: 'q1' }]);
  expect(last(events)).toMatchObject({ type: 'output', output: 'finished' });
  await harness.runtime.dispose();
});

test('an interaction ID that is not pending is rejected and nothing runs', async () => {
  const harness = await setup({ reply: once('x'), agent: confirming([]) });
  const receipt = await harness.answer(
    'approve',
    { indexes: [0] },
    {
      ...harness.pending(),
      interactionId: 'other' as PendingInteraction['interactionId'],
    },
  );
  expect(receipt).toMatchObject({ status: 'rejected', error: { code: 'stale' } });
  expect(harness.invocations).toHaveLength(0);
  await harness.runtime.dispose();
});

test('the default resume fails closed on an unknown action, a short cover or a repeated index', async () => {
  for (const [action, payload] of [
    ['maybe', { indexes: [0] }],
    ['approve', { indexes: [] }],
    ['approve', { indexes: [0, 0] }],
    ['approve', {}],
    ['approve', { indexes: [0], extra: true }],
  ] as const) {
    const harness = await setup({ reply: once('x'), agent: confirming([]) });
    await harness.answer(action, payload);
    const events = await finish(harness);
    expect(last(events)).toMatchObject({ type: 'error', error: { code: 'invalid' } });
    expect(harness.invocations).toHaveLength(0);
    await harness.runtime.dispose();
  }
});

test('an interaction hook that returns an invalid request fails unsupported with a fixed message', async () => {
  const canary = 'canary-tool-argument-5c1d';
  const harness = await setup({
    reply: once(canary),
    agent: (host) =>
      defineAdkEntry({
        agent: new LlmAgent({
          name: 'agent',
          model: host.adk.llm('agent'),
          instruction: 'x',
          tools: [host.adk.capabilityTool('docs.search@1', gate)],
        }),
        interaction: (requests) => ({ props: requests }),
      }),
  });
  expect(last(harness.events)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
  expect(JSON.stringify(harness.events)).not.toContain(canary);
  expect(harness.invocations).toHaveLength(0);
  await harness.runtime.dispose();
});

test('a long-running tool pauses and the payload supplies its result', async () => {
  const seen: AdkPendingRequest[][] = [];
  const harness = await setup({
    reply: once('x'),
    agent: (host) =>
      defineAdkEntry({
        agent: new LlmAgent({
          name: 'agent',
          model: host.adk.llm('agent'),
          instruction: 'x',
          tools: [host.adk.capabilityTool('docs.search@1', { ...search, longRunning: true })],
        }),
        interaction: (requests) => {
          seen.push([...requests]);
          return request(requests.length);
        },
        resume: (requests, _action, payload) =>
          requests.map(() => ({ response: { result: (payload as { result: string }).result } })),
      }),
  });
  expect(seen[0]).toEqual([{ kind: 'long-running', tool: 'docs_search_1', args: { q: 'x' } }]);
  expect(harness.invocations).toEqual([{ q: 'x' }]);
  await harness.answer('provide', { result: 'external-result-77' });
  const events = await finish(harness);
  expect(last(events)).toMatchObject({ type: 'output', output: 'finished' });
  const toolText = harness.model.seen
    .at(-1)
    ?.messages.filter((message) => message.type === 'tool')
    .map((message) => String(message.content))
    .join(' ');
  expect(toolText).toContain('external-result-77');
  await harness.runtime.dispose();
});

test('a request for input fails unsupported because ADK hides its answer from an LlmAgent', async () => {
  const harness = await setup({
    reply: () =>
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_0', name: 'adk_request_input', args: { message: 'Name?' } }],
      }),
    agent: (host) =>
      defineAdkEntry({
        agent: new LlmAgent({
          name: 'agent',
          model: host.adk.llm('agent'),
          instruction: 'x',
          tools: [host.adk.requestInput()],
        }),
        interaction: (requests) => request(requests.length),
      }),
  });
  expect(last(harness.events)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
  expect(interactionsOf(harness.events)).toHaveLength(0);
  await harness.runtime.dispose();
});

test('a pause that includes a long-running call needs an author resume', async () => {
  const harness = await setup({
    reply: once('x'),
    agent: (host) =>
      defineAdkEntry({
        agent: new LlmAgent({
          name: 'agent',
          model: host.adk.llm('agent'),
          instruction: 'x',
          tools: [host.adk.capabilityTool('docs.search@1', { ...search, longRunning: true })],
        }),
        interaction: (requests) => request(requests.length),
      }),
  });
  await harness.answer('approve', { indexes: [0] });
  const events = await finish(harness);
  expect(last(events)).toMatchObject({ type: 'error', error: { code: 'invalid' } });
  await harness.runtime.dispose();
});

test('a sibling call that ran beside a confirmation fails unsupported instead of losing its result', async () => {
  const tracker = new PauseTracker();
  const call = (id: string, name: string, args: Record<string, unknown>) => ({
    functionCall: { id, name, args },
  });
  expect(
    tracker.observe({
      author: 'agent',
      content: { role: 'model', parts: [call('a', 'lookup', {}), call('b', 'gated', {})] },
    } as never),
  ).toBe(false);
  expect(() =>
    tracker.observe({
      author: 'agent',
      content: {
        role: 'user',
        parts: [
          call('c', 'adk_request_confirmation', {
            originalFunctionCall: { id: 'b', name: 'gated', args: {} },
            toolConfirmation: { confirmed: false },
          }),
        ],
      },
    } as never),
  ).toThrow();
});

test('no call ID, argument or hint reaches events or spans', async () => {
  const canary = 'canary-pause-argument-3e9a';
  const harness = await setup({ reply: once(canary), agent: confirming([]) });
  await harness.answer('approve', { indexes: [0] });
  const events = await finish(harness);
  const shown = JSON.stringify([harness.events, events]);
  expect(shown).not.toContain(canary);
  expect(shown).not.toMatch(/galaxie-\d|adk_request_confirmation/);
  expect(JSON.stringify(recorder.spans())).not.toContain(canary);
  await harness.runtime.dispose();
});

test('a new start after an invalid resume answers the abandoned call, so the model sees a denial', async () => {
  const harness = await setup({ reply: once('x'), agent: confirming([]) });
  await harness.answer('approve', { indexes: [0], extra: true });
  const failed = await finish(harness);
  expect(last(failed)).toMatchObject({ type: 'error', error: { code: 'invalid' } });
  const { runId } = await harness.instance.start({ prompt: 'again' });
  const again: RunEvent[] = [];
  for await (const event of harness.instance.events(runId)) again.push(event);
  expect(last(again)).toMatchObject({ type: 'output', output: 'finished' });
  const tools = harness.model.seen
    .at(-1)
    ?.messages.filter((message) => message.type === 'tool')
    .map((message) => String(message.content))
    .join(' ');
  expect(tools).toContain('rejected');
  expect(harness.invocations).toHaveLength(0);
  await harness.runtime.dispose();
});

test('a confirmation beside a long-running call in one turn fails unsupported before anything runs', async () => {
  const harness = await setup({
    reply: () =>
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'call_0', name: 'slow', args: { q: 'a' } },
          { id: 'call_1', name: 'gated', args: { q: 'b' } },
        ],
      }),
    agent: (host) =>
      defineAdkEntry({
        agent: new LlmAgent({
          name: 'agent',
          model: host.adk.llm('agent'),
          instruction: 'x',
          tools: [
            host.adk.capabilityTool('docs.search@1', {
              ...search,
              toolName: 'slow',
              longRunning: true,
            }),
            host.adk.capabilityTool('docs.search@1', { ...gate, toolName: 'gated' }),
          ],
        }),
        interaction: (requests) => request(requests.length),
        resume: (requests) => requests.map(() => ({ confirmed: true })),
      }),
  });
  expect(last(harness.events)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
  expect(interactionsOf(harness.events)).toHaveLength(0);
  expect(harness.invocations).not.toContainEqual({ q: 'b' });
  await harness.runtime.dispose();
});

test('a pause inside a ParallelAgent fails unsupported', async () => {
  const harness = await setup({
    reply: once('x'),
    agent: (host) =>
      defineAdkEntry({
        agent: new ParallelAgent({
          name: 'fan',
          subAgents: [
            new LlmAgent({
              name: 'agent',
              model: host.adk.llm('agent'),
              instruction: 'x',
              tools: [host.adk.capabilityTool('docs.search@1', gate)],
            }),
          ],
        }),
        interaction: (requests) => request(requests.length),
      }),
  });
  expect(last(harness.events)).toMatchObject({ type: 'error', error: { code: 'unsupported' } });
  expect(harness.invocations).toHaveLength(0);
  await harness.runtime.dispose();
});

test('long-running calls whose results never arrive are reported, not dropped', () => {
  const tracker = new PauseTracker();
  expect(
    tracker.observe({
      author: 'agent',
      longRunningToolIds: ['a'],
      content: { role: 'model', parts: [{ functionCall: { id: 'a', name: 'slow', args: {} } }] },
    } as never),
  ).toBe(false);
  expect(tracker.unanswered).toBe(true);
});

/** A scripted model for driving ADK's own checks without the adapter. */
class ScriptedLlm extends BaseLlm {
  constructor() {
    super({ model: 'scripted' });
  }
  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse> {
    const answered = request.contents.some((content) =>
      (content.parts ?? []).some((part) => part.functionResponse !== undefined),
    );
    yield answered
      ? { content: { role: 'model', parts: [{ text: 'finished' }] } }
      : {
          content: {
            role: 'model',
            parts: [{ functionCall: { id: 'call-1', name: 'gated', args: { q: 'safe' } } }],
          },
        };
  }
  override async connect(): Promise<never> {
    throw new Error('not live');
  }
}

test('ADK rejects a resume whose stored confirmation call was altered', async () => {
  const { FunctionTool, ToolCallIntegrityPlugin } = await import('@google/adk');
  let ran = 0;
  const tool = new FunctionTool({
    name: 'gated',
    description: 'gated tool',
    parameters: z.object({ q: z.string() }),
    requireConfirmation: true,
    execute: async () => {
      ran += 1;
      return { ok: true };
    },
  });
  let tamper = false;
  class Tampering extends GalaxieSessionService {
    override async getSession(
      ...args: Parameters<GalaxieSessionService['getSession']>
    ): ReturnType<GalaxieSessionService['getSession']> {
      const session = await super.getSession(...args);
      if (tamper && session !== undefined)
        for (const event of session.events)
          for (const part of event.content?.parts ?? []) {
            const original: unknown = part.functionCall?.args?.['originalFunctionCall'];
            if (typeof original === 'object' && original !== null)
              Reflect.set(original, 'args', { q: 'tampered' });
          }
      return session;
    }
  }
  const sessions = new Tampering();
  const runner = new Runner({
    appName: 'galaxie',
    agent: new LlmAgent({
      name: 'agent',
      model: new ScriptedLlm(),
      instruction: 'x',
      tools: [tool],
    }),
    plugins: [
      new ToolCallIntegrityPlugin({ secretKey: crypto.getRandomValues(new Uint8Array(32)) }),
    ],
    sessionService: sessions,
  });
  const base = { userId: 'galaxie', sessionId: 's1' };
  await sessions.createSession({ appName: 'galaxie', ...base });
  const tracker = new PauseTracker();
  for await (const event of runner.runAsync({
    ...base,
    newMessage: { role: 'user', parts: [{ text: 'go' }] },
  }))
    if (tracker.observe(event)) break;
  const confirmation = tracker.calls?.[0];
  expect(confirmation?.request.kind).toBe('confirmation');
  tamper = true;
  await expect(
    (async () => {
      for await (const _ of runner.runAsync({
        ...base,
        newMessage: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: confirmation?.id ?? '',
                name: 'adk_request_confirmation',
                response: { confirmed: true },
              },
            },
          ],
        },
      }))
        void _;
    })(),
  ).rejects.toMatchObject({ cause: { name: 'ToolCallIntegrityError' } });
  expect(ran).toBe(0);
});
