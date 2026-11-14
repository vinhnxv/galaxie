// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  GalaxieError,
  type RunEvent,
  type SessionId,
} from '@galaxie-ai/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, AIMessageChunk, type BaseMessage } from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createGoAdapter } from '../../packages/adapter-go/src/index.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import {
  buildReference,
  disposeReference,
  goAvailable,
  type NodeHost,
  startNodeHost,
} from './support/adk-go.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

let node: NodeHost | undefined;
beforeAll(async () => {
  if (goAvailable) node = await startNodeHost(await buildReference());
}, 900000);
afterAll(async () => {
  await node?.close();
  await disposeReference();
});

class WrapperModel extends BaseChatModel {
  readonly requests: { role: string; messages: BaseMessage[] }[] = [];
  readonly failure: string | undefined;
  readonly twice: boolean;
  lateFailures = 0;
  constructor(options: { failure?: string; twice?: boolean } = {}) {
    super({});
    this.failure = options.failure;
    this.twice = options.twice ?? false;
  }
  override _llmType(): string {
    return 'adk-go-wrapper-gates';
  }
  override bindTools(): WrapperModel {
    return this;
  }
  override async *_streamResponseChunks(
    messages: BaseMessage[],
  ): AsyncGenerator<ChatGenerationChunk> {
    const result = await this._generate(messages);
    const message = result.generations[0]?.message as AIMessage;
    yield new ChatGenerationChunk({
      text: String(message.content),
      message: new AIMessageChunk({ content: message.content, tool_calls: message.tool_calls }),
    });
  }
  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const role = messages.some((message) =>
      String(message.content).includes('Your internal name is "inner"'),
    )
      ? 'inner'
      : 'outer';
    this.requests.push({ role, messages });
    if (role === 'inner' && this.failure === 'hang')
      return new Promise<ChatResult>(() => undefined);
    if (role === 'inner' && this.failure && this.failure !== 'blocked' && this.failure !== 'late')
      throw new GalaxieError(this.failure as 'unavailable', 'Fixture failure.');
    if (
      role === 'outer' &&
      this.failure === 'late' &&
      messages.some((message) => message.type === 'tool') &&
      this.lateFailures++ === 0
    )
      throw new GalaxieError('unavailable', 'Fixture failure after inner completion.');
    const content =
      role === 'inner'
        ? this.failure === 'blocked'
          ? 'BLOCKED_INNER'
          : 'inner answer'
        : 'outer answer';
    const calls =
      role === 'outer' && !messages.some((message) => message.type === 'tool')
        ? Array.from({ length: this.twice ? 2 : 1 }, (_, index) => ({
            id: `provider-${index}`,
            name: 'inner',
            args: { request: `question-${index}` },
          }))
        : [];
    const message = new AIMessage({ content: calls.length ? '' : content, tool_calls: calls });
    return { generations: [{ text: String(message.content), message }] };
  }
}

const store = () => ({
  checkpoints: new MemoryByteCheckpoints(),
  recovery: new MemoryRecoveryStore(),
});
async function open(
  options: {
    entry?: string;
    model?: WrapperModel;
    steps?: number;
    bytes?: ReturnType<typeof store>;
    sessionId?: SessionId;
  } = {},
) {
  if (!node) throw new Error('The host did not start.');
  const currentNode = node;
  const frames: { op: string; payload: string }[] = [];
  const bytes = options.bytes ?? store();
  const model = options.model ?? new WrapperModel();
  const baseAdapter = createGoAdapter({
    createWorker: () => {
      const worker = currentNode.createWorker();
      worker.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          const frame = JSON.parse(event.data);
          if (frame.kind === 'call') frames.push(frame);
        }
      });
      return worker;
    },
  });
  const conversation = options.sessionId;
  // Completed sessions are exercised at the adapter seam, retaining the real runtime router.
  const adapter: typeof baseAdapter =
    conversation === undefined
      ? baseAdapter
      : {
          ...baseAdapter,
          async prepare(agent, services, preparation) {
            const prepared = await baseAdapter.prepare(agent, services, preparation);
            return {
              run(request) {
                return prepared.run({ ...request, sessionId: conversation });
              },
              pending(_sessionId, readOptions) {
                return prepared.pending(conversation, readOptions);
              },
              dispose() {
                return prepared.dispose();
              },
            };
          },
        };
  const runtime = createRuntime({
    appId: 'adk-go-wrapper-gates',
    executors: [adapter],
    budgets: { steps: options.steps ?? 20, toolCalls: 10, tokens: 5000 },
    outputSafety: ({ text }) => (text.includes('BLOCKED_INNER') ? 'block' : 'allow'),
  });
  const role = {
    modality: 'text' as const,
    languages: ['en'],
    defaultPolicy: 'local-only' as const,
  };
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'tests/adk-go-wrapper',
      version: '1.0.0',
      executor: 'adk-go',
      input: z.object({ prompt: z.string() }),
      models: { outer: role, inner: role },
    }),
    {
      principalScope: 'fixture',
      agent: { wasm: currentNode.wasm, entry: options.entry ?? 'agent-tool-plain', stream: true },
      recovery: bytes.recovery,
      services: { chatModels: { mock: model }, checkpoints: bytes.checkpoints },
      models: {
        providers: {
          mock: {
            destination: 'in-browser',
            modality: 'text',
            languages: ['en'],
            features: ['tool-calling', 'streaming'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: {
          outer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 },
          inner: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 },
        },
      },
    },
  );
  return { runtime, instance, model, bytes, frames };
}
type Current = Awaited<ReturnType<typeof open>>;
async function run(current: Current, prompt = 'go') {
  const { runId } = await current.instance.start({ prompt });
  const events: RunEvent[] = [];
  for await (const event of current.instance.events(runId)) events.push(event);
  return {
    events,
    error: events.findLast((event) => event.type === 'error')?.error,
    output: events.findLast((event) => event.type === 'output')?.output,
  };
}
function saved(current: Current): unknown[] {
  return [...current.bytes.checkpoints.rows.values()].map((row) =>
    JSON.parse(new TextDecoder().decode(row.checkpoint.bytes)),
  );
}

test.skipIf(!goAvailable)(
  'Go AgentTool routes three requests and keeps the inner session and stream private',
  async () => {
    const current = await open({ model: new WrapperModel({ twice: true }) });
    try {
      await current.instance.prepare();
      const result = await run(current);
      expect(result.error).toBeUndefined();
      expect(result.output).toBe('outer answer');
      expect(current.model.requests.map((request) => request.role)).toEqual([
        'outer',
        'inner',
        'inner',
        'outer',
      ]);
      for (const request of current.model.requests.filter((request) => request.role === 'inner'))
        expect(request.messages.filter((message) => message.type !== 'system')).toHaveLength(1);
      const models = current.frames
        .filter((frame) => frame.op === 'model')
        .map((frame) => JSON.parse(frame.payload));
      expect(
        models
          .filter((request) => request.role === 'inner')
          .every((request) => request.options.stream !== true),
      ).toBe(true);
      expect(
        JSON.stringify(result.events.filter((event) => event.type === 'stream')),
      ).not.toContain('inner answer');
      const records = saved(current) as { events: { author: string }[] }[];
      expect(records.at(-1)?.events.every((event) => event.author !== 'inner')).toBe(true);
    } finally {
      await current.runtime.dispose();
    }
  },
  900000,
);

test.skipIf(!goAvailable)(
  'Go AgentTool shares router budget and fails closed on blocked and provider replies',
  async () => {
    for (const failure of ['unavailable', 'blocked', 'budget'])
      for (const restored of [false, true]) {
        const bytes = store();
        let sessionId: SessionId | undefined;
        if (restored) {
          const first = await open({ bytes });
          try {
            await first.instance.prepare();
            expect((await run(first)).error).toBeUndefined();
            sessionId = first.instance.sessionId;
          } finally {
            await first.runtime.dispose();
          }
        }
        const current = await open({
          bytes,
          ...(sessionId ? { sessionId } : {}),
          model: new WrapperModel(failure === 'budget' ? {} : { failure }),
          ...(failure === 'budget' ? { steps: 1 } : {}),
        });
        try {
          await current.instance.prepare();
          const baseline = structuredClone([...bytes.checkpoints.rows.values()]);
          const result = await run(current);
          expect(result.error?.code).toBe(
            failure === 'blocked'
              ? 'denied'
              : failure === 'budget'
                ? 'budget_exceeded'
                : 'unavailable',
          );
          expect(current.model.requests.filter((request) => request.role === 'outer')).toHaveLength(
            1,
          );
          expect([...bytes.checkpoints.rows.values()]).toEqual(baseline);
        } finally {
          await current.runtime.dispose();
        }
      }
  },
  900000,
);

test.skipIf(!goAvailable)(
  'Go AgentTool excludes every refused inner shape before dispatch',
  async () => {
    const prepareCodes: (string | undefined)[] = [];
    for (const kind of [
      'capability',
      'confirmation',
      'long-running',
      'exit',
      'toolset',
      'nested',
      'input-schema',
      'output-schema',
      'duplicate',
      'collision',
      'foreign',
    ]) {
      const current = await open({ entry: `agent-tool-${kind}` });
      try {
        try {
          await current.instance.prepare();
          prepareCodes.push(undefined);
        } catch (error) {
          prepareCodes.push((error as { code: string }).code);
        }
        expect((await run(current)).error?.code).toBe('unsupported');
        expect(current.frames).toEqual([]);
      } finally {
        await current.runtime.dispose();
      }
    }
    expect(prepareCodes.every((code) => code === 'unsupported')).toBe(true);
  },
  900000,
);

test.skipIf(!goAvailable)(
  'Go AgentTool rolls back failure after inner completion and retries over unchanged restored history',
  async () => {
    const bytes = store();
    const first = await open({ bytes });
    let sessionId: SessionId;
    try {
      await first.instance.prepare();
      expect((await run(first, 'before')).error).toBeUndefined();
      sessionId = first.instance.sessionId;
    } finally {
      await first.runtime.dispose();
    }
    const current = await open({ bytes, sessionId, model: new WrapperModel({ failure: 'late' }) });
    try {
      await current.instance.prepare();
      const baseline = structuredClone([...bytes.checkpoints.rows.values()]);
      expect((await run(current, 'failed')).error?.code).toBe('unavailable');
      expect(current.model.requests.map((request) => request.role)).toEqual([
        'outer',
        'inner',
        'outer',
      ]);
      expect([...bytes.checkpoints.rows.values()]).toEqual(baseline);
      const failedHistory = current.model.requests[0]?.messages
        .filter((message) => message.type !== 'system')
        .slice(0, -1);
      expect((await run(current, 'retry')).output).toBe('outer answer');
      const retryHistory = current.model.requests[3]?.messages
        .filter((message) => message.type !== 'system')
        .slice(0, -1);
      expect(retryHistory).toEqual(failedHistory);
      expect(JSON.stringify(current.model.requests[3]?.messages)).not.toContain('failed');
    } finally {
      await current.runtime.dispose();
    }
  },
  900000,
);

test.skipIf(!goAvailable)(
  'Go AgentTool matches native declaration, copied temp state and absent forwarded state live and restored',
  async () => {
    const bytes = store();
    let sessionId: SessionId | undefined;
    for (const restored of [false, true]) {
      const current = await open({
        bytes,
        entry: 'agent-tool-state',
        model: new WrapperModel({ twice: true }),
        ...(restored && sessionId ? { sessionId } : {}),
      });
      try {
        await current.instance.prepare();
        const result = await run(current);
        expect(result.error).toBeUndefined();
        expect(result.output).toBe('outer answer');
        const first = current.frames
          .filter((frame) => frame.op === 'model')
          .map((frame) => JSON.parse(frame.payload))[0];
        expect(first.options.tools).toEqual([
          {
            type: 'function',
            function: {
              name: 'inner',
              description: 'Answer one question.',
              parameters: {
                type: 'object',
                properties: { request: { type: 'string' } },
                required: ['request'],
              },
            },
          },
        ]);
        const responses = current.model.requests
          .at(-1)
          ?.messages.filter((message) => message.type === 'tool');
        expect(responses?.map((message) => JSON.parse(String(message.content)))).toEqual([
          { result: 'inner answer' },
          { result: 'inner answer' },
        ]);
        sessionId = current.instance.sessionId;
      } finally {
        await current.runtime.dispose();
      }
    }
  },
  900000,
);

test.skipIf(!goAvailable)(
  'Go AgentTool measures completed restore call ID uniqueness',
  async () => {
    const bytes = store();
    const first = await open({ bytes, model: new WrapperModel({ twice: true }) });
    let sessionId: SessionId;
    let initial: unknown;
    try {
      await first.instance.prepare();
      expect((await run(first)).error).toBeUndefined();
      sessionId = first.instance.sessionId;
      initial = saved(first).at(-1);
    } finally {
      await first.runtime.dispose();
    }
    const next = await open({ bytes, sessionId, model: new WrapperModel({ twice: true }) });
    try {
      await next.instance.prepare();
      expect((await run(next, 'after')).error).toBeUndefined();
      const ids = (record: unknown): string[] =>
        (
          record as { events: { content?: { parts: { functionCall?: { id: string } }[] } }[] }
        ).events.flatMap(
          (event) =>
            event.content?.parts.flatMap((part) =>
              part.functionCall ? [part.functionCall.id] : [],
            ) ?? [],
        );
      const before = ids(initial),
        after = ids(saved(next).at(-1));
      expect(before).toHaveLength(2);
      expect(after).toHaveLength(2);
      expect(before.some((id) => after.includes(id))).toBe(false);
    } finally {
      await next.runtime.dispose();
    }
  },
  900000,
);

test.skipIf(!goAvailable)(
  'Go AgentTool inner error events and abort end the run before another outer request live and restored',
  async () => {
    for (const restored of [false, true]) {
      for (const entry of ['agent-tool-event', 'agent-tool-direct-event']) {
        const bytes = store();
        let sessionId: SessionId | undefined;
        if (restored) {
          const first = await open({ bytes });
          try {
            await first.instance.prepare();
            await run(first);
            sessionId = first.instance.sessionId;
          } finally {
            await first.runtime.dispose();
          }
        }
        const current = await open({ bytes, entry, ...(sessionId ? { sessionId } : {}) });
        try {
          await current.instance.prepare();
          const baseline = structuredClone([...bytes.checkpoints.rows.values()]);
          expect((await run(current)).error?.code).toBe('unavailable');
          expect(current.model.requests).toHaveLength(entry === 'agent-tool-event' ? 1 : 0);
          expect([...bytes.checkpoints.rows.values()]).toEqual(baseline);
        } finally {
          await current.runtime.dispose();
        }
      }
      const bytes = store();
      let sessionId: SessionId | undefined;
      if (restored) {
        const first = await open({ bytes });
        try {
          await first.instance.prepare();
          await run(first);
          sessionId = first.instance.sessionId;
        } finally {
          await first.runtime.dispose();
        }
      }
      const current = await open({
        bytes,
        model: new WrapperModel({ failure: 'hang' }),
        ...(sessionId ? { sessionId } : {}),
      });
      try {
        await current.instance.prepare();
        const baseline = structuredClone([...bytes.checkpoints.rows.values()]);
        const { runId } = await current.instance.start({ prompt: 'cancel' });
        const collecting = (async () => {
          const events: RunEvent[] = [];
          for await (const event of current.instance.events(runId)) events.push(event);
          return events;
        })();
        await vi.waitFor(() =>
          expect(current.model.requests.map((request) => request.role)).toEqual(['outer', 'inner']),
        );
        await current.instance.cancel(runId);
        await collecting;
        expect(current.instance.getSnapshot().run?.status).toBe('cancelled');
        expect(current.model.requests.map((request) => request.role)).toEqual(['outer', 'inner']);
        expect([...bytes.checkpoints.rows.values()]).toEqual(baseline);
      } finally {
        await current.runtime.dispose();
      }
    }
  },
  900000,
);

test.skipIf(!goAvailable)(
  'Go AgentTool completed live and fresh-Worker continuation have equal decoded history',
  async () => {
    const bytes = store();
    const live = await open({ bytes });
    let sessionId: SessionId;
    let history: BaseMessage[] | undefined;
    let events: unknown;
    const restoredBytes = store();
    try {
      await live.instance.prepare();
      expect((await run(live, 'seed')).error).toBeUndefined();
      sessionId = live.instance.sessionId;
      for (const [key, row] of bytes.checkpoints.rows)
        restoredBytes.checkpoints.rows.set(key, structuredClone(row));
      for (const [key, row] of bytes.checkpoints.writes)
        restoredBytes.checkpoints.writes.set(key, structuredClone(row));
      expect((await run(live, 'continue')).error).toBeUndefined();
      history = live.model.requests[3]?.messages;
      events = (saved(live).at(-1) as { events: unknown }).events;
    } finally {
      await live.runtime.dispose();
    }
    const restored = await open({ bytes: restoredBytes, sessionId });
    try {
      await restored.instance.prepare();
      expect((await run(restored, 'continue')).error).toBeUndefined();
      expect(restored.model.requests[0]?.messages).toEqual(history);
      expect((saved(restored).at(-1) as { events: unknown }).events).toEqual(events);
      // Completed Go sessions intentionally start a fresh history in either lane.
      expect(JSON.stringify(history)).not.toContain('seed');
    } finally {
      await restored.runtime.dispose();
    }
  },
  900000,
);
