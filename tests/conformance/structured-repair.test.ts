// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter } from '@galaxie-ai/adapter-langgraph';
import {
  type AgentSnapshot,
  type BudgetLimits,
  createRuntime,
  type DiagnosticEvent,
  defineAgentDefinition,
  galaxieField,
  toErrorInfo,
} from '@galaxie-ai/core';
import { createMockLatch, MockChatModel, type MockScriptEntry } from '@galaxie-ai/models/mock';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { type BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';
import {
  assertSpanTree,
  createSpanRecorder,
  serializeSpans,
} from '../../packages/core/test/span-tree.js';

const INSTRUCTION =
  'The previous reply did not match the required JSON Schema. Reply again with only JSON that matches the schema.';
const CANARY = 'private-repair-reply-canary';
const VALID = '{"answer":"yes"}';
const schema = z.object({ answer: z.literal('yes') });
const original = [new SystemMessage('Return a JSON answer.'), new HumanMessage('hello')];

/** Sequence selection is test-only; every response still uses the deterministic mock provider. */
class SequenceModel extends MockChatModel {
  readonly messages: BaseMessage[][] = [];
  readonly schemas: unknown[] = [];

  constructor(entries: readonly MockScriptEntry[]) {
    super(Object.fromEntries(entries.map((entry, index) => [String(index), entry])));
  }

  #next(messages: BaseMessage[], options: this['ParsedCallOptions']): BaseMessage[] {
    this.messages.push([...messages]);
    this.schemas.push(Reflect.get(options, 'jsonSchema'));
    return [new HumanMessage(String(this.calls))];
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    return super._generate(this.#next(messages, options), options);
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    manager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* super._streamResponseChunks(this.#next(messages, options), options, manager);
  }
}

async function runRepair(options: {
  readonly replies: readonly (string | MockScriptEntry)[];
  readonly repairAttempts?: number;
  readonly budgets?: Partial<BudgetLimits>;
  readonly includeRaw?: boolean;
  readonly calls?: number;
  readonly stream?: boolean;
  readonly refine?: boolean;
  readonly stop?: 'cancel' | 'dispose';
  readonly reroute?: boolean;
  readonly blockRepair?: boolean;
}) {
  const latch = createMockLatch();
  const entries = options.replies.map((reply, index) => {
    const entry = typeof reply === 'string' ? { id: `reply-${index}`, text: reply } : reply;
    return options.stop !== undefined && index === 1 ? { ...entry, wait: latch } : entry;
  });
  const model = new SequenceModel(entries);
  const diagnostics: DiagnosticEvent[] = [];
  const snapshots: AgentSnapshot<unknown>[] = [];
  const values: unknown[] = [];
  const errors: unknown[] = [];
  const consent = vi.fn(() => true);
  const safety = vi.fn(({ text }: { text: string }) =>
    options.blockRepair && text === VALID ? ('block' as const) : ('allow' as const),
  );
  const { exporter, provider } = createSpanRecorder();
  const runtime = createRuntime({
    appId: 'structured-repair',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    diagnostics: (event) => diagnostics.push(event),
    outputSafety: safety,
    budgets: { steps: 2, toolCalls: 0, ...options.budgets },
  });
  const definition = defineAgentDefinition({
    id: 'tests/structured-repair',
    version: '1.0.0',
    executor: 'langgraph-js',
    input: z.object({ text: z.string().meta(galaxieField({ label: 'public' })) }),
    models: { assistant: { modality: 'text' } },
  });
  try {
    const instance = await runtime.create(definition, {
      principalScope: 'test',
      models: {
        providers: {
          local: {
            destination: 'in-browser',
            modality: 'text',
            features: ['structured-output'],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
          remote: {
            destination: 'third-party',
            modality: 'text',
            features: ['structured-output'],
            pricing: 'unknown',
          },
        },
        roles: {
          assistant: {
            providers: options.reroute ? ['local', 'remote'] : ['local'],
            allow: options.reroute ? ['in-browser', 'third-party'] : ['in-browser'],
            maxTokens: 10,
            ...(options.reroute ? { maxCost: 1 } : {}),
            ...(options.repairAttempts === undefined
              ? {}
              : { repairAttempts: options.repairAttempts }),
          },
        },
        consent,
        availability: ({ providerId }) => ({
          status:
            providerId === 'local' && options.reroute && model.calls > 0
              ? 'unavailable'
              : 'available',
        }),
      },
      services: { chatModels: { local: model, remote: model } },
      agent: (host) => {
        const outputSchema = options.refine
          ? z.object({
              answer: z
                .string()
                .refine((answer) => answer === 'yes', { message: `validator-${CANARY}` }),
            })
          : schema;
        const chat = host.langchain.chatModel('assistant');
        const structured = (
          options.includeRaw
            ? chat.withStructuredOutput(outputSchema, { includeRaw: true })
            : chat.withStructuredOutput(outputSchema)
        ).withConfig({ tags: ['nostream'] });
        return new StateGraph(
          Annotation.Root({ text: Annotation<string>, ok: Annotation<boolean> }),
        )
          .addNode('respond', async (_state, config) => {
            try {
              for (let call = 0; call < (options.calls ?? 1); call++) {
                if (options.stream) {
                  for await (const value of await structured.stream(original, config))
                    values.push(value);
                } else values.push(await structured.invoke(original, config));
              }
              return { ok: true };
            } catch (error) {
              errors.push(error);
              throw error;
            }
          })
          .addEdge(START, 'respond')
          .addEdge('respond', END)
          .compile();
      },
    });
    instance.subscribe(() => snapshots.push(instance.getSnapshot()));
    await instance.prepare();
    const { runId } = await instance.start({ text: 'input' });
    const waiting = collect(instance.events(runId));
    if (options.stop !== undefined) {
      await latch.entered;
      if (options.stop === 'cancel') await instance.cancel(runId);
      else await instance.dispose();
    }
    const events = await waiting;
    await runtime.dispose();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    assertSpanTree(spans);
    const observed = [...errors, ...diagnostics.map((event) => event.error)];
    expect(
      JSON.stringify({
        events,
        snapshots,
        spans: serializeSpans(spans),
        diagnostics,
        errors: observed.map((error) =>
          error instanceof Error ? { message: error.message, cause: error.cause } : error,
        ),
      }),
    ).not.toContain(CANARY);
    return {
      model,
      events,
      snapshot: instance.getSnapshot(),
      values,
      errors,
      spans,
      consent,
      safety,
    };
  } finally {
    latch.release();
    await runtime.dispose();
    await provider.shutdown();
  }
}

test('repair is off by default with one provider call and a fixed invalid error', async () => {
  const result = await runRepair({ replies: [CANARY, VALID] });
  expect(result.model.calls).toBe(1);
  expect(result.snapshot.run).toMatchObject({ status: 'failed', error: toErrorInfo('invalid') });
  expect(result.errors[0]).toMatchObject({
    code: 'invalid',
    message: toErrorInfo('invalid').message,
  });
  expect(result.errors[0]).not.toHaveProperty('cause');
});

test.each([false, true])(
  'one repair succeeds with caller config, schema and ordinary spans (stream=%s)',
  async (stream) => {
    const result = await runRepair({ replies: [CANARY, VALID], repairAttempts: 1, stream });
    expect(result.values).toEqual([{ answer: 'yes' }]);
    expect(result.snapshot.run?.status).toBe('succeeded');
    expect(result.model.calls).toBe(2);
    expect(
      result.model.messages.map((messages) =>
        messages.map((message) => [message.type, message.content]),
      ),
    ).toEqual([
      [
        ['system', 'Return a JSON answer.'],
        ['human', 'hello'],
      ],
      [
        ['system', 'Return a JSON answer.'],
        ['human', 'hello'],
        ['ai', CANARY],
        ['human', INSTRUCTION],
      ],
    ]);
    expect(result.model.schemas).toEqual([toJsonSchema(schema), toJsonSchema(schema)]);
    const chats = result.spans.filter((span) => span.name.startsWith('chat'));
    expect(chats).toHaveLength(2);
    expect(result.safety.mock.calls.map(([request]) => request.text)).toContain(VALID);
  },
);

test.each([false, true])(
  'per-call limit stops after exactly two replies (includeRaw=%s)',
  async (includeRaw) => {
    const result = await runRepair({
      replies: [CANARY, `second-${CANARY}`, VALID],
      repairAttempts: 1,
      includeRaw,
    });
    expect(result.model.calls).toBe(2);
    if (includeRaw) {
      expect(result.values).toMatchObject([{ raw: { content: `second-${CANARY}` }, parsed: null }]);
      expect(result.snapshot.run?.status).toBe('succeeded');
    } else
      expect(result.snapshot.run).toMatchObject({
        status: 'failed',
        error: toErrorInfo('invalid'),
      });
  },
);

test('includeRaw returns the repaired reply and parsed value', async () => {
  const result = await runRepair({ replies: [CANARY, VALID], repairAttempts: 1, includeRaw: true });
  expect(result.values).toMatchObject([{ raw: { content: VALID }, parsed: { answer: 'yes' } }]);
});

test('JSON Schema failure repairs again using only the original messages and latest reply', async () => {
  const invalid = `{"answer":"${CANARY}"}`;
  const result = await runRepair({ replies: [CANARY, invalid, VALID], repairAttempts: 2 });
  expect(result.values).toEqual([{ answer: 'yes' }]);
  expect(result.model.calls).toBe(3);
  expect(result.model.messages[2]?.map((message) => [message.type, message.content])).toEqual([
    ['system', 'Return a JSON answer.'],
    ['human', 'hello'],
    ['ai', invalid],
    ['human', INSTRUCTION],
  ]);
});

test('the default run budget allows two repairs and refuses a third', async () => {
  const result = await runRepair({ replies: [CANARY, CANARY, CANARY, VALID], repairAttempts: 3 });
  expect(result.model.calls).toBe(3);
  expect(result.snapshot.run?.error?.code).toBe('budget_exceeded');
  expect(
    result.spans.find((span) => span.name.startsWith('invoke_agent'))?.attributes,
  ).toMatchObject({ 'galaxie.budget.name': 'repairAttempts' });
});

test.each([false, true])(
  'run-wide exhaustion is rethrown and recorded on the root span (includeRaw=%s)',
  async (includeRaw) => {
    const result = await runRepair({
      replies: [CANARY, CANARY, VALID],
      repairAttempts: 2,
      budgets: { repairAttempts: 1 },
      includeRaw,
    });
    expect(result.model.calls).toBe(2);
    expect(result.snapshot.run).toMatchObject({
      status: 'failed',
      error: toErrorInfo('budget_exceeded'),
    });
    expect(
      result.spans.find((span) => span.name.startsWith('invoke_agent'))?.attributes,
    ).toMatchObject({
      'galaxie.error.code': 'budget_exceeded',
      'galaxie.budget.name': 'repairAttempts',
    });
  },
);

test('the repair budget is shared by structured invocations in a run', async () => {
  const result = await runRepair({
    replies: [CANARY, VALID, CANARY, VALID],
    repairAttempts: 1,
    calls: 2,
    budgets: { repairAttempts: 1 },
  });
  expect(result.model.calls).toBe(3);
  expect(result.values).toEqual([{ answer: 'yes' }]);
  expect(result.snapshot.run?.error?.code).toBe('budget_exceeded');
});

test('each repair consumes an ordinary token reservation before dispatch', async () => {
  const result = await runRepair({
    replies: [CANARY, CANARY, VALID],
    repairAttempts: 2,
    budgets: { tokens: 20 },
  });
  expect(result.model.calls).toBe(2);
  expect(
    result.spans.find((span) => span.name.startsWith('invoke_agent'))?.attributes,
  ).toMatchObject({ 'galaxie.budget.name': 'tokens' });
});

test('content-parser failures repair without validator text in the prompt or errors', async () => {
  const result = await runRepair({
    replies: [`{"answer":"${CANARY}"}`, VALID],
    repairAttempts: 1,
    refine: true,
  });
  expect(result.values).toEqual([{ answer: 'yes' }]);
  expect(result.model.calls).toBe(2);
  expect(JSON.stringify(result.model.messages)).not.toContain(`validator-${CANARY}`);
});

test('repair reselects a destination with consent and cost accounting', async () => {
  const result = await runRepair({
    replies: [CANARY, VALID],
    repairAttempts: 1,
    reroute: true,
    budgets: { cost: 1 },
  });
  expect(result.values).toEqual([{ answer: 'yes' }]);
  expect(result.consent).toHaveBeenCalledTimes(1);
  expect(
    result.spans
      .filter((span) => span.name.startsWith('chat'))
      .map((span) => span.attributes['galaxie.model.provider']),
  ).toEqual(['local', 'remote']);
  expect(result.snapshot.routes?.['assistant']).toEqual({
    providerId: 'remote',
    destination: 'third-party',
    changedFrom: 'in-browser',
  });
});

test('repair cost reservations stop another remote dispatch', async () => {
  const result = await runRepair({
    replies: [CANARY, CANARY, VALID],
    repairAttempts: 2,
    reroute: true,
    budgets: { cost: 1 },
  });
  expect(result.model.calls).toBe(2);
  expect(result.snapshot.run?.error?.code).toBe('budget_exceeded');
  expect(
    result.spans.find((span) => span.name.startsWith('invoke_agent'))?.attributes,
  ).toMatchObject({ 'galaxie.budget.name': 'cost' });
});

test('output safety blocks a repair without dispatching another repair', async () => {
  const result = await runRepair({
    replies: [CANARY, VALID, VALID],
    repairAttempts: 2,
    blockRepair: true,
  });
  expect(result.model.calls).toBe(2);
  expect(result.snapshot.run?.error?.code).toBe('denied');
});

test.each(['cancel', 'dispose'] as const)(
  'abort during repair stops further dispatch (%s)',
  async (stop) => {
    const result = await runRepair({
      replies: [CANARY, CANARY, VALID],
      repairAttempts: 2,
      includeRaw: true,
      stop,
    });
    expect(result.model.calls).toBe(2);
    expect(result.values).toEqual([]);
    expect(result.snapshot.run?.status).toBe('cancelled');
  },
);
