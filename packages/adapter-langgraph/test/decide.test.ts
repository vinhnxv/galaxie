// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  type DecisionModel,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResult,
  galaxieField,
  type ModelCall,
  type ModelPreparation,
  type OutputSafetyHook,
  toErrorInfo,
} from '@galaxie/core';
import {
  Annotation,
  END,
  type LangGraphRunnableConfig,
  START,
  StateGraph,
} from '@langchain/langgraph/web';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { budgetLimits, RunBudget } from '../../core/src/budgets.js';
import { collect, definition } from '../../core/test/fake-executor.js';
import { createMockLatch, MockChatModel, MockDecisionModel } from '../../models/src/mock.js';
import { createLangGraphAdapter } from '../src/adapter.js';
import {
  createHost,
  type LangGraphAgent,
  type LangGraphServices,
  validServices,
} from '../src/host.js';
import { LangGraphTraceHandler } from '../src/trace-handler.js';

const request: DecisionRequest = {
  state: 'private-state-canary',
  questions: {
    route: {
      type: 'choice',
      instructions: 'Choose a route.',
      options: { ask: 'Ask', answer: 'Answer' },
    },
  },
};
const reply: DecisionResult = {
  answers: { route: { value: 'ask', probabilities: { ask: 0.75, answer: 0.25 } } },
  usage: { inputTokens: 3, outputTokens: 0 },
};
const preparation: ModelPreparation = {
  roles: ['triage', 'assistant'],
  decisionRoles: ['triage'],
  providers: {
    decision: { modality: 'decision', credential: false },
    text: { credential: false },
  },
};

function fixture(provider: DecisionProvider = new MockDecisionModel([reply]), credential = false) {
  const end = vi.fn();
  const fail = vi.fn();
  const checkOutput = vi.fn(async () => {});
  const lease: ModelCall = {
    providerId: 'decision',
    destination: 'in-browser',
    maxTokens: 64,
    outputSafetyOutcome: 'unset',
    checkOutput,
    end,
    fail,
    ...(credential ? { credential: 'ephemeral-credential-canary' } : {}),
  };
  const begin = vi.fn(async () => lease);
  const controller = new AbortController();
  const budget = new RunBudget(budgetLimits());
  const traceEnd = vi.fn();
  const traceStart = vi.fn(() => ({ end: traceEnd }));
  const handler = new LangGraphTraceHandler({ recordsText: false, start: traceStart });
  const chat = new MockChatModel({});
  const capabilities = { call: vi.fn(async () => null) };
  const payload = vi.fn((value: unknown) => budget.payload(value));
  let active = true;
  const host = createHost(
    { chatModels: { text: chat }, decisionModels: { decision: provider } },
    capabilities,
    {
      ...preparation,
      providers: { ...preparation.providers, decision: { modality: 'decision', credential } },
    },
    () =>
      active
        ? { capabilities, models: { begin }, handler, signal: controller.signal, payload }
        : undefined,
  );
  return {
    host,
    begin,
    end,
    fail,
    checkOutput,
    controller,
    chat,
    payload,
    handler,
    traceStart,
    traceEnd,
    stop: () => {
      active = false;
    },
  };
}

test('one routed call validates and checks the whole answer before one usage settlement', async () => {
  const provider: DecisionModel = new MockDecisionModel([reply]);
  const decide = vi.spyOn(provider, 'decide');
  const f = fixture(provider);
  const controller = new AbortController();
  const answers = await f.host.langchain.decide('triage', request, {
    signal: controller.signal,
    metadata: { langgraph_node: 'triage' },
  });
  expect(answers).toEqual(reply.answers);
  expect(f.begin).toHaveBeenCalledTimes(1);
  expect(decide).toHaveBeenCalledExactlyOnceWith(request, {
    maxTokens: 64,
    signal: expect.any(AbortSignal),
  });
  expect(f.payload).toHaveBeenCalledTimes(2);
  expect(f.checkOutput).toHaveBeenCalledExactlyOnceWith(JSON.stringify(reply.answers), {
    final: true,
  });
  expect(f.end).toHaveBeenCalledExactlyOnceWith(reply.usage);
  expect(f.fail).not.toHaveBeenCalled();
  expect(f.chat.calls).toBe(0);
  expect(f.traceEnd).toHaveBeenCalledWith(
    expect.objectContaining({ outputSafetyOutcome: 'unset' }),
  );
});

test('role entry points refuse the other modality and undeclared roles before leasing', async () => {
  const f = fixture();
  for (const role of ['triage', 'unknown'])
    expect(() => f.host.langchain.chatModel(role)).toThrowError(
      expect.objectContaining({ code: 'unavailable' }),
    );
  for (const role of ['assistant', 'unknown'])
    await expect(f.host.langchain.decide(role, request)).rejects.toMatchObject({
      code: 'unavailable',
    });
  expect(f.begin).not.toHaveBeenCalled();
});

test('decision calls outside an active run fail before leasing', async () => {
  const f = fixture();
  f.stop();
  await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
    code: 'invalid',
  });
  expect(f.begin).not.toHaveBeenCalled();
});

test('explicit node config retains the decision span parent after an await', async () => {
  const f = fixture();
  f.handler.handleChainStart(
    {},
    {},
    'node',
    undefined,
    [],
    { langgraph_node: 'triage' },
    undefined,
    'triage',
  );
  const parent = f.traceStart.mock.results[0]?.value;
  const config = {
    callbacks: { getParentRunId: () => 'node' },
  } as unknown as LangGraphRunnableConfig;
  await Promise.resolve();
  await f.host.langchain.decide('triage', request, config);
  expect(f.traceStart).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'model' }), parent);
});

test.each(['block', 'fail'] as const)(
  'an output hook %s prevents answer publication and charges once',
  async (mode) => {
    const f = fixture();
    f.checkOutput.mockImplementation(async () => {
      throw Object.assign(new Error('private-hook-canary'), {
        name: 'GalaxieError',
        code: mode === 'block' ? 'denied' : 'unavailable',
      });
    });
    await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
      code: mode === 'block' ? 'denied' : 'unavailable',
      message: toErrorInfo(mode === 'block' ? 'denied' : 'unavailable').message,
    });
    expect(f.end).not.toHaveBeenCalled();
    expect(f.fail).toHaveBeenCalledTimes(1);
  },
);

test('an invalid reply fails once without repair or another provider dispatch', async () => {
  const provider = new MockDecisionModel([
    { invalid: { answers: { route: { value: 'private-reply-canary' } } } },
    reply,
  ]);
  const f = fixture(provider);
  await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
    code: 'invalid',
    message: toErrorInfo('invalid').message,
  });
  expect(provider.calls).toBe(1);
  expect(f.begin).toHaveBeenCalledTimes(1);
  expect(f.end).not.toHaveBeenCalled();
  expect(f.fail).toHaveBeenCalledTimes(1);
  expect(f.checkOutput).not.toHaveBeenCalled();
});

test.each([undefined, { inputTokens: NaN, outputTokens: 0 }])(
  'missing or invalid usage settles at the reservation %#',
  async (usage) => {
    const f = fixture(
      new MockDecisionModel([
        { answers: reply.answers, ...(usage === undefined ? {} : { usage }) },
      ]),
    );
    await f.host.langchain.decide('triage', request);
    expect(f.end).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.fail).not.toHaveBeenCalled();
  },
);

test('provider failures are fixed and never switch to the text provider', async () => {
  const provider = new MockDecisionModel([{ error: new Error('private-provider-error-canary') }]);
  const f = fixture(provider);
  await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
    code: 'unavailable',
    message: toErrorInfo('unavailable').message,
  });
  expect(provider.calls).toBe(1);
  expect(f.chat.calls).toBe(0);
  expect(f.fail).toHaveBeenCalledTimes(1);
});

test('credential factories receive only the per-call credential', async () => {
  const provider = new MockDecisionModel([reply, reply]);
  const factory = vi.fn(() => provider);
  const f = fixture(factory, true);
  await f.host.langchain.decide('triage', request);
  await f.host.langchain.decide('triage', request);
  expect(factory).toHaveBeenCalledTimes(2);
  expect(factory).toHaveBeenCalledWith({ credential: 'ephemeral-credential-canary' });
  expect(JSON.stringify(provider.recordedCalls)).not.toContain('credential-canary');
});

test.each(['caller-before', 'caller-during', 'run-during'] as const)(
  'cancellation %s never publishes a decision',
  async (mode) => {
    const wait = createMockLatch();
    const provider = new MockDecisionModel([{ ...reply, wait }]);
    const f = fixture(provider);
    const caller = new AbortController();
    if (mode === 'caller-before') caller.abort(new Error('private-abort-canary'));
    const pending = f.host.langchain.decide('triage', request, { signal: caller.signal });
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'cancelled',
      message: toErrorInfo('cancelled').message,
    });
    if (mode !== 'caller-before') {
      await wait.entered;
      (mode === 'run-during' ? f.controller : caller).abort(new Error('private-abort-canary'));
    }
    await rejected;
    expect(f.end).not.toHaveBeenCalled();
    expect(f.fail).toHaveBeenCalledTimes(mode === 'caller-before' ? 0 : 1);
    expect(provider.calls).toBe(mode === 'caller-before' ? 0 : 1);
    wait.release();
  },
);

test('request payload is checked before leasing and answer payload before output publication', async () => {
  for (const stage of [1, 2]) {
    const f = fixture();
    f.payload.mockImplementation((value) => {
      if (f.payload.mock.calls.length === stage) {
        f.controller.abort();
        return new RunBudget(budgetLimits({ payloadBytes: 0 })).payload(value);
      }
      return JSON.stringify(value);
    });
    await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
    expect(f.begin).toHaveBeenCalledTimes(stage === 1 ? 0 : 1);
    expect(f.fail).toHaveBeenCalledTimes(stage === 1 ? 0 : 1);
    expect(f.checkOutput).not.toHaveBeenCalled();
  }
});

test.each([false, true])(
  'preparation requires matching decision provider credential shape %s',
  async (credential) => {
    const graph = () => ({
      stream: async () => (async function* () {})(),
      transform: async function* () {},
      getState: async () => ({ tasks: [] }),
    });
    const provider = new MockDecisionModel([reply]);
    const models = {
      roles: ['triage'],
      decisionRoles: ['triage'],
      providers: { decision: { modality: 'decision' as const, credential } },
    };
    const wrong = credential ? provider : () => provider;
    await expect(
      createLangGraphAdapter().prepare(
        graph,
        { chatModels: {}, decisionModels: { decision: wrong } },
        { signal: new AbortController().signal, models },
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      createLangGraphAdapter().prepare(
        graph,
        { chatModels: { decision: new MockChatModel({}) } },
        { signal: new AbortController().signal, models },
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
  },
);

test.each(
  [null, [], { decision: {} }, { decision: new MockChatModel({}) }].map((decisionModels) => ({
    decisionModels,
  })),
)('services reject malformed decision providers %#', ({ decisionModels }) => {
  expect(validServices({ chatModels: {}, decisionModels })).toBe(false);
});

test('services accept optional decision providers and legacy chat services', () => {
  expect(validServices({ chatModels: {} })).toBe(true);
  const services = { chatModels: {}, decisionModels: { decision: new MockDecisionModel([]) } };
  expect(validServices(services)).toBe(true);
});

async function runGraph(
  options: {
    private?: boolean;
    usage?: number;
    hook?: OutputSafetyHook;
    payloadBytes?: number;
    failure?: boolean;
  } = {},
) {
  const provider = new MockDecisionModel([
    options.failure
      ? { error: new Error('private-provider-error-canary') }
      : { ...reply, usage: { inputTokens: options.usage ?? 3, outputTokens: 0 } },
  ]);
  const backup = new MockDecisionModel([reply]);
  const consent = vi.fn(() => true);
  const state = Annotation.Root({
    prompt: Annotation<string>,
    answers: Annotation<DecisionResult['answers']>,
  });
  const agent: LangGraphAgent = (host) =>
    new StateGraph(state)
      .addNode('triage', async ({ prompt }, config) => ({
        answers: await host.langchain.decide('triage', { ...request, state: prompt }, config),
      }))
      .addEdge(START, 'triage')
      .addEdge('triage', END)
      .compile({ checkpointer: host.langchain.checkpointer() });
  const destination = options.private ? ('third-party' as const) : ('in-browser' as const);
  const runtime = createRuntime({
    appId: 'decision-test',
    executors: [createLangGraphAdapter()],
    budgets: {
      tokens: 10,
      ...(options.payloadBytes === undefined ? {} : { payloadBytes: options.payloadBytes }),
    },
    ...(options.hook === undefined ? {} : { outputSafety: options.hook }),
  });
  try {
    const instance = await runtime.create(
      {
        ...definition,
        executor: 'langgraph-js',
        input: z.object({
          prompt: z
            .string()
            .meta(galaxieField({ label: options.private ? 'private-user' : 'public' })),
        }),
        models: { triage: { modality: 'decision' } },
      },
      {
        principalScope: 'user',
        agent,
        services: {
          chatModels: {},
          decisionModels: { decision: provider, backup },
        } satisfies LangGraphServices,
        models: {
          providers: {
            decision: {
              modality: 'decision',
              destination,
              features: [],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
            backup: {
              modality: 'decision',
              destination,
              features: [],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: {
            triage: { providers: ['decision', 'backup'], allow: [destination], maxTokens: 10 },
          },
          consent,
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({ prompt: 'private-state-canary' });
    const events = await collect(instance.events(runId));
    return {
      events,
      calls: provider.calls,
      backupCalls: backup.calls,
      consent,
      snapshot: instance.getSnapshot(),
    };
  } finally {
    await runtime.dispose();
  }
}

test('the real runtime executes one decision lease and publishes its destination notice', async () => {
  const f = await runGraph();
  expect(f.calls).toBe(1);
  expect(f.events.at(-1)).toMatchObject({ type: 'output', output: { answers: reply.answers } });
  expect(f.snapshot.routes).toEqual({
    triage: { providerId: 'decision', destination: 'in-browser' },
  });
});

test('private run state blocks the third-party provider even with a consent hook', async () => {
  const f = await runGraph({ private: true });
  expect(f.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'denied' } });
  expect(f.calls).toBe(0);
  expect(f.consent).not.toHaveBeenCalled();
});

test('over-budget settlement fails the real run without publishing the answer', async () => {
  const f = await runGraph({ usage: 11 });
  expect(f.calls).toBe(1);
  expect(f.events.some((event) => event.type === 'output')).toBe(false);
  expect(f.events).toContainEqual(
    expect.objectContaining({
      type: 'error',
      error: expect.objectContaining({ code: 'budget_exceeded' }),
    }),
  );
});

test('a dispatched failure does not invoke another listed decision provider', async () => {
  const f = await runGraph({ failure: true });
  expect(f.calls).toBe(1);
  expect(f.backupCalls).toBe(0);
  expect(f.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'unavailable' } });
});

test('the real run payload budget rejects the whole request before provider dispatch', async () => {
  const f = await runGraph({ payloadBytes: 64 });
  expect(f.calls).toBe(0);
  expect(f.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'budget_exceeded' } });
});

test('a real output hook sees complete JSON and blocks delivery', async () => {
  const hook = vi.fn<OutputSafetyHook>(() => 'block');
  const f = await runGraph({ hook });
  expect(hook).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      text: JSON.stringify(reply.answers),
      final: true,
      role: 'triage',
    }),
  );
  expect(f.events.at(-1)).toMatchObject({ type: 'error', error: { code: 'denied' } });
});
