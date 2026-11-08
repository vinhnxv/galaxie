// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type AgentSnapshot,
  createRuntime,
  type DecisionModel,
  type DecisionRequest,
  type DecisionResult,
  defineAgentDefinition,
  type ViewRevision,
} from '@galaxie-ai/core';
import {
  Annotation,
  END,
  isGraphInterrupt,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import { expect, onTestFinished, test, vi } from 'vitest';
import { z } from 'zod';
import { collect } from '../../core/test/fake-executor.js';
import { createStructuredDecisionModel } from '../../models/src/decision/structured.js';
import { MockChatModel, MockDecisionModel } from '../../models/src/mock.js';
import {
  createLangGraphAdapter,
  type DecisionGate,
  type GatedDecision,
  gateDecision,
} from '../src/index.js';

const interaction: DecisionGate['interaction'] = {
  component: 'tests.DecisionAsk/v1',
  props: { text: 'Would you like to continue?' },
  surfaceId: 'decision',
  viewRevision: 'v1' as ViewRevision,
};
const gate: DecisionGate = { threshold: 0.7, interaction };
const high: DecisionResult['answers'] = { proceed: { value: true, confidence: 0.9 } };

async function fixture(
  answers: DecisionResult['answers'] = high,
  settings: DecisionGate = gate,
  options: { provider?: DecisionModel; handBuilt?: unknown } = {},
) {
  const model = new MockDecisionModel([{ answers, raw: 'model-text-canary' }]);
  const received: GatedDecision[] = [];
  const failures: unknown[] = [];
  const snapshots: AgentSnapshot<unknown>[] = [];
  const runtime = createRuntime({
    appId: 'decision-gate',
    executors: [createLangGraphAdapter()],
  });
  onTestFinished(() => runtime.dispose());
  const questions: DecisionRequest['questions'] = Object.fromEntries(
    Object.entries(answers).map(([name, answer]) => [
      name,
      typeof answer.value === 'string'
        ? {
            type: 'choice',
            instructions: 'Choose the next step.',
            options: { [answer.value]: 'Continue', stop: 'Stop' },
          }
        : { type: 'boolean', instructions: 'May the agent continue?' },
    ]),
  );
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'tests/decision-gate',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({}),
      models: { triage: { modality: 'decision' } },
    }),
    {
      principalScope: 'fixture',
      services: {
        chatModels: {},
        decisionModels: { decision: options.provider ?? model },
        checkpointer: new MemorySaver(),
      },
      models: {
        consent: () => true,
        providers: {
          decision: {
            modality: 'decision',
            destination: 'in-browser',
            features: [],
            pricing: { inputPerToken: 0, outputPerToken: 0 },
          },
        },
        roles: { triage: { providers: ['decision'], allow: ['in-browser'], maxTokens: 128 } },
      },
      ui: {
        components: {
          'tests.DecisionAsk/v1': {
            actions: { continue: { payload: z.object({ choice: z.boolean() }) } },
          },
        },
        surfaces: ['decision'],
      },
      agent: (host) =>
        new StateGraph(Annotation.Root({ answers: Annotation<DecisionResult['answers']> }))
          .addNode('decide', async (_state, config) => ({
            answers: await host.langchain.decide(
              'triage',
              { state: 'state-text-canary', questions },
              config,
            ),
          }))
          .addNode('gate', ({ answers: decided }, config) => {
            try {
              const result = gateDecision(
                Object.hasOwn(options, 'handBuilt')
                  ? (options.handBuilt as DecisionResult['answers'])
                  : decided,
                settings,
                config,
              );
              received.push(result);
              return { answers: result.answers };
            } catch (error) {
              if (!isGraphInterrupt(error)) failures.push(error);
              throw error;
            }
          })
          .addEdge(START, 'decide')
          .addEdge('decide', 'gate')
          .addEdge('gate', END)
          .compile({ checkpointer: host.langchain.checkpointer() }),
    },
  );
  instance.subscribe(() => snapshots.push(instance.getSnapshot()));
  await instance.prepare();
  const { runId } = await instance.start({});
  return {
    instance,
    runId,
    events: collect(instance.events(runId)),
    received,
    failures,
    snapshots,
    model,
  };
}

async function exercise(
  answers: DecisionResult['answers'],
  settings: DecisionGate,
  asks: boolean,
  options: { provider?: DecisionModel; handBuilt?: unknown } = {},
) {
  const f = await fixture(answers, settings, options);
  if (asks) {
    await vi.waitFor(() => expect(f.instance.getSnapshot().run?.status).toBe('waiting_input'));
    const pending = f.instance.getSnapshot().run?.pending;
    if (pending === undefined) throw new Error('Missing decision question.');
    expect(pending.props).toEqual(interaction.props);
    expect(JSON.stringify(pending)).not.toMatch(
      /answer-text-canary|state-text-canary|model-text-canary/,
    );
    expect(f.received).toEqual([]);
    await expect(
      f.instance.dispatch({
        ...pending,
        instanceId: f.instance.instanceId,
        runId: f.runId,
        action: 'continue',
        payload: { choice: true },
      }),
    ).resolves.toMatchObject({ status: 'accepted' });
  }
  const events = await f.events;
  expect(f.instance.getSnapshot().run?.status).toBe('succeeded');
  expect(events.filter((event) => event.type === 'interaction')).toHaveLength(asks ? 1 : 0);
  expect(f.received).toHaveLength(1);
  expect(f.received[0]).toMatchObject({ asked: asks });
  if (asks)
    expect(f.received[0]?.submission).toEqual({ action: 'continue', payload: { choice: true } });
  else {
    expect(f.received[0]).not.toHaveProperty('submission');
    expect(f.snapshots.some((snapshot) => snapshot.run?.status === 'waiting_input')).toBe(false);
  }
  expect(Object.isFrozen(f.received[0]?.answers)).toBe(true);
  expect(Object.isFrozen(f.received[0]?.answers['proceed'])).toBe(true);
  return f;
}

test.each([
  { confidence: 0.9, threshold: 0.7, asks: false },
  { confidence: 0.5, threshold: 0.7, asks: true },
  { confidence: undefined, threshold: 0, asks: true },
  { confidence: 0.7, threshold: 0.7, asks: false },
  { confidence: 0.699999, threshold: 0.7, asks: true },
  { confidence: 0, threshold: 0, asks: false },
  { confidence: 1, threshold: 1, asks: false },
])(
  'real graph gates confidence $confidence at $threshold',
  async ({ confidence, threshold, asks }) => {
    const answers = {
      proceed: { value: true, ...(confidence === undefined ? {} : { confidence }) },
    };
    const f = await exercise(answers, { ...gate, threshold }, asks);
    expect(f.received[0]?.answers).toEqual(answers);
    expect(f.model.calls).toBe(1);
  },
);

test.each([
  { other: { value: false, confidence: 0.4 }, questions: undefined, asks: true },
  { other: { value: false }, questions: undefined, asks: true },
  { other: { value: false }, questions: ['proceed'], asks: false },
  { other: { value: false, confidence: 0.4 }, questions: ['proceed'], asks: false },
  { other: { value: false }, questions: ['proceed', 'other'], asks: true },
])('checks every selected question %#', async ({ other, questions, asks }) => {
  const f = await exercise(
    { ...high, other },
    { ...gate, ...(questions === undefined ? {} : { questions }) },
    asks,
  );
  expect(f.model.calls).toBe(1);
});

test.each([
  ...[NaN, Infinity, -0.1, 1.1, 'threshold-canary'].map((threshold) => ({ ...gate, threshold })),
  ...[[], ['proceed', 'proceed'], ['absent-canary'], [7], 'proceed'].map((questions) => ({
    ...gate,
    questions,
  })),
  ...[null, undefined, 'interaction-canary', []].map((interaction) => ({ ...gate, interaction })),
])('invalid host gate fails before publishing an interaction %#', async (settings) => {
  const f = await fixture(high, settings as DecisionGate);
  const events = await f.events;
  expect(f.instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'invalid', message: 'The request is invalid.' },
  });
  expect(f.failures).toEqual([
    expect.objectContaining({ code: 'invalid', message: 'The decision gate is invalid.' }),
  ]);
  expect(events.some((event) => event.type === 'interaction')).toBe(false);
  expect(f.snapshots.every((snapshot) => snapshot.run?.pending === undefined)).toBe(true);
});

test.each([-0.1, 1.1, NaN, Infinity, 'confidence-canary', undefined])(
  'hand-built malformed confidence asks: %s',
  async (confidence) => {
    const f = await exercise(high, gate, true, {
      handBuilt: { proceed: { value: true, confidence } },
    });
    expect(f.model.calls).toBe(1);
  },
);

test('a confidence accessor is never invoked, including on resume', async () => {
  const getter = vi.fn(() => 1);
  const answer = Object.defineProperty({ value: true }, 'confidence', {
    get: getter,
    enumerable: true,
  });
  await exercise(high, gate, true, { handBuilt: { proceed: answer } });
  expect(getter).not.toHaveBeenCalled();
});

test('invalid gate configuration is rejected before inspecting hand-built answers', async () => {
  const inspect = vi.fn(() => {
    throw new Error('answers-inspection-canary');
  });
  const handBuilt = new Proxy({}, { getPrototypeOf: inspect, ownKeys: inspect });
  const f = await fixture(high, { ...gate, threshold: NaN }, { handBuilt });
  await f.events;
  expect(f.failures).toEqual([
    expect.objectContaining({ code: 'invalid', message: 'The decision gate is invalid.' }),
  ]);
  expect(inspect).not.toHaveBeenCalled();
});

test.each([
  null,
  [],
  new Date(),
  { proceed: null },
  { proceed: [] },
  { proceed: new Date() },
  Object.defineProperty({}, 'proceed', { value: null }),
])('hand-built non-plain answers fail with fixed invalid %#', async (handBuilt) => {
  const f = await fixture(high, gate, { handBuilt });
  await f.events;
  expect(f.instance.getSnapshot().run).toMatchObject({
    status: 'failed',
    error: { code: 'invalid', message: 'The request is invalid.' },
  });
  expect(f.failures).toEqual([
    expect.objectContaining({ code: 'invalid', message: 'The decision gate is invalid.' }),
  ]);
  expect(f.snapshots.every((snapshot) => snapshot.run?.pending === undefined)).toBe(true);
});

test('returned answers detach and freeze nested mutable input', async () => {
  const handBuilt = {
    proceed: { value: ['continue'], confidence: 0.9, probabilities: { continue: 1 } },
  };
  const f = await exercise(high, gate, false, { handBuilt });
  handBuilt.proceed.value.push('stop');
  handBuilt.proceed.probabilities.continue = 0;
  expect(f.received[0]?.answers).toEqual({
    proceed: { value: ['continue'], confidence: 0.9, probabilities: { continue: 1 } },
  });
  expect(Object.isFrozen(f.received[0]?.answers['proceed']?.value)).toBe(true);
  expect(Object.isFrozen(f.received[0]?.answers['proceed']?.probabilities)).toBe(true);
});

test('published question contains host text without answer, state or model canaries', async () => {
  await exercise({ proceed: { value: 'answer-text-canary' } }, gate, true);
});

test.each(['{"proceed":true}', '{"proceed":true,"confidence":1}'])(
  'structured-output decisions always ask even when JSON volunteers confidence: %s',
  async (text) => {
    // The scripted chat mock matches the whole human message the provider builds.
    const questions = { proceed: { type: 'boolean', instructions: 'May the agent continue?' } };
    const prompt = `<state>\n"state-text-canary"\n</state>\n<questions>\n${JSON.stringify(questions)}\n</questions>`;
    const chat = new MockChatModel({ [prompt]: { id: 'decision-json', text } });
    const f = await exercise(high, { ...gate, threshold: 0 }, true, {
      provider: createStructuredDecisionModel(chat),
    });
    expect(f.received[0]?.answers).toEqual({ proceed: { value: true } });
    expect(chat.calls).toBe(1);
  },
);
