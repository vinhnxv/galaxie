// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type {
  DecisionModel,
  DecisionRequest,
  ModelCall,
  ModelPort,
  ModelRouting,
  OutputSafetyHook,
} from '@galaxie/core';
import { expect, test, vi } from 'vitest';
import { BudgetExceeded, budgetLimits, RunBudget } from '../../core/src/budgets.js';
import { ModelRouter, type ModelRun } from '../../core/src/model-router.js';
import { type BudgetLimits, type DataLabel, DEFAULT_DATA_POLICY } from '../../core/src/policy.js';
import { definition } from '../../core/test/fake-executor.js';
import { createStructuredDecisionModel } from '../../models/src/decision/structured.js';
import { createMockLatch, MockChatModel, MockDecisionModel } from '../../models/src/mock.js';
import { createHost } from '../src/host.js';
import { LangGraphTraceHandler } from '../src/trace-handler.js';

const request: DecisionRequest = {
  state: 'state-canary',
  questions: {
    route: { type: 'choice', instructions: 'Choose.', options: { ask: 'Ask', answer: 'Answer' } },
  },
};
const invalid = {
  answers: { route: { value: 'unknown' } },
  raw: '{"route":"unknown"}',
  usage: { inputTokens: 2, outputTokens: 1 },
};
const valid = {
  answers: { route: { value: 'ask' } },
  raw: '{"route":"ask"}',
  usage: { inputTokens: 4, outputTokens: 2 },
};

function fixture(
  provider: DecisionModel,
  options: {
    repairs?: number;
    budgets?: Partial<BudgetLimits>;
    hook?: OutputSafetyHook;
    remote?: boolean;
    private?: boolean;
    consent?: boolean;
    backup?: DecisionModel;
    availability?: ModelRouting['availability'];
  } = {},
) {
  const controller = new AbortController();
  const consent = vi.fn(() => options.consent ?? true);
  const destination = options.remote ? ('third-party' as const) : ('in-browser' as const);
  const descriptor = {
    modality: 'decision' as const,
    destination,
    features: [],
    pricing: { inputPerToken: 0, outputPerToken: 0 },
  };
  const router = new ModelRouter(
    {
      ...definition,
      models: { triage: { modality: 'decision' }, assistant: { modality: 'text' } },
    },
    {
      providers: {
        decision: descriptor,
        ...(options.backup === undefined ? {} : { backup: descriptor }),
        text: {
          modality: 'text',
          destination: 'in-browser',
          features: [],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
        },
      },
      roles: {
        triage: {
          providers: options.backup === undefined ? ['decision'] : ['decision', 'backup'],
          allow: [destination],
          maxTokens: 10,
          repairAttempts: options.repairs ?? 0,
        },
        assistant: { providers: ['text'], allow: ['in-browser'], maxTokens: 10 },
      },
      consent,
      ...(options.availability === undefined ? {} : { availability: options.availability }),
    },
    DEFAULT_DATA_POLICY,
    () => {},
    options.hook,
  );
  const budget = new RunBudget(budgetLimits(options.budgets));
  const run: ModelRun = {
    runId: 'decision-repair' as ModelRun['runId'],
    signal: controller.signal,
    labels: new Set<DataLabel>([options.private ? 'private-user' : 'public']),
    budget,
    active: () => !controller.signal.aborted,
    failBudget: (name) => {
      throw new BudgetExceeded(name);
    },
    selectedRouteChanged: () => {},
  };
  let open = 0;
  const leases: { end: ModelCall['end']; fail: ModelCall['fail'] }[] = [];
  const port = router.port(run);
  const begin = vi.fn<ModelPort['begin']>(async (role, callOptions) => {
    expect(open).toBe(0);
    const lease = await port.begin(role, callOptions);
    open++;
    const end = vi.fn<ModelCall['end']>((usage) => {
      open--;
      lease.end(usage);
    });
    const fail = vi.fn<ModelCall['fail']>(() => {
      open--;
      lease.fail();
    });
    leases.push({ end, fail });
    return {
      ...lease,
      end,
      fail,
      get outputSafetyOutcome() {
        return lease.outputSafetyOutcome;
      },
    };
  });
  const chat = new MockChatModel({});
  const traceEnd = vi.fn();
  const capabilities = { call: vi.fn(async () => null) };
  const host = createHost(
    {
      chatModels: { text: chat },
      decisionModels: {
        decision: provider,
        ...(options.backup === undefined ? {} : { backup: options.backup }),
      },
    },
    capabilities,
    router.summary,
    () => ({
      models: { begin },
      capabilities,
      handler: new LangGraphTraceHandler({ recordsText: false, start: () => ({ end: traceEnd }) }),
      signal: controller.signal,
      payload: (value) => budget.payload(value),
    }),
  );
  return { host, begin, leases, chat, controller, consent, traceEnd, run, open: () => open };
}

function structured(raw: string): { model: DecisionModel; chat: MockChatModel } {
  const prompt = `<state>\n${JSON.stringify(request.state)}\n</state>\n<questions>\n${JSON.stringify(request.questions)}\n</questions>`;
  const chat = new MockChatModel({ [prompt]: { id: 'decision', text: raw } });
  return { model: createStructuredDecisionModel(chat), chat };
}

test.each(['not JSON', '[]', '{"route":"unknown"}'])(
  'structured reply %s fails fixed invalid without an allowed repair',
  async (raw) => {
    const provider = structured(raw);
    const f = fixture(provider.model);
    await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
      code: 'invalid',
      message: 'The request is invalid.',
    });
    expect(provider.chat.calls).toBe(1);
    expect(f.leases).toHaveLength(1);
    expect(f.leases[0]?.end).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.leases[0]?.fail).not.toHaveBeenCalled();
    expect(f.open()).toBe(0);
  },
);

test('repair uses two sequential leases with exact usage and raw-only feedback', async () => {
  const provider = new MockDecisionModel([
    { invalid: { answers: invalid.answers, usage: invalid.usage }, raw: invalid.raw },
    valid,
  ]);
  const hook = vi.fn<OutputSafetyHook>(() => 'allow');
  const f = fixture(provider, { repairs: 1, hook, budgets: { tokens: 13 } });
  expect(await f.host.langchain.decide('triage', request)).toEqual(valid.answers);
  expect(provider.recordedCalls.map((call) => call.repair)).toEqual([
    undefined,
    { attempt: 1, reply: invalid.raw },
  ]);
  expect(f.begin.mock.calls[1]?.[1]).toMatchObject({ repairAttempt: 1 });
  expect(f.leases).toHaveLength(2);
  for (const [index, lease] of f.leases.entries()) {
    expect(lease.end).toHaveBeenCalledExactlyOnceWith(index === 0 ? invalid.usage : valid.usage);
    expect(lease.fail).not.toHaveBeenCalled();
  }
  expect(hook.mock.calls.map(([call]) => call.text)).toEqual([
    invalid.raw,
    valid.raw,
    JSON.stringify(valid.answers),
  ]);
  expect(f.chat.calls).toBe(0);
  expect(f.traceEnd).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.traceEnd.mock.calls)).not.toContain('unknown');
  expect(f.open()).toBe(0);
});

test('a second invalid answer exhausts the route without a third lease or dispatch', async () => {
  const provider = new MockDecisionModel([invalid, invalid, valid]);
  const f = fixture(provider, { repairs: 1 });
  await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
    code: 'invalid',
    message: 'The request is invalid.',
  });
  expect(provider.calls).toBe(2);
  expect(f.leases).toHaveLength(2);
  for (const lease of f.leases) {
    expect(lease.end).toHaveBeenCalledTimes(1);
    expect(lease.fail).not.toHaveBeenCalled();
  }
  expect(f.open()).toBe(0);
});

test('the default shared run budget allows only two repairs across decision calls', async () => {
  const provider = new MockDecisionModel([invalid, valid, invalid, valid, invalid, valid]);
  const f = fixture(provider, { repairs: 1 });
  await f.host.langchain.decide('triage', request);
  await f.host.langchain.decide('triage', request);
  await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
    code: 'budget_exceeded',
  });
  expect(provider.calls).toBe(5);
  expect(f.leases).toHaveLength(5);
  expect(f.open()).toBe(0);
});

test('a repair reservation failure stops before a second dispatch', async () => {
  const provider = new MockDecisionModel([invalid, valid]);
  const f = fixture(provider, { repairs: 1, budgets: { tokens: 10 } });
  await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
    code: 'budget_exceeded',
  });
  expect(provider.calls).toBe(1);
  expect(f.leases).toHaveLength(1);
  expect(f.leases[0]?.end).toHaveBeenCalledExactlyOnceWith(invalid.usage);
  expect(f.leases[0]?.fail).not.toHaveBeenCalled();
});

test.each(['block', 'fail'] as const)(
  'a raw output hook %s stops before answer validation or repair',
  async (mode) => {
    const provider = new MockDecisionModel([invalid, valid]);
    const hook = vi.fn<OutputSafetyHook>(() => {
      if (mode === 'block') return 'block';
      throw new Error('hook-canary');
    });
    const f = fixture(provider, { repairs: 1, hook });
    await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
      code: mode === 'block' ? 'denied' : 'unavailable',
    });
    expect(provider.calls).toBe(1);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(f.leases[0]?.fail).toHaveBeenCalledTimes(1);
    expect(f.leases[0]?.end).not.toHaveBeenCalled();
  },
);

test('cancellation during a repair stops without another lease', async () => {
  const wait = createMockLatch();
  const provider = new MockDecisionModel([invalid, { ...valid, wait }, valid]);
  const f = fixture(provider, { repairs: 3 });
  const pending = f.host.langchain.decide('triage', request);
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  await wait.entered;
  f.controller.abort(new Error('abort-canary'));
  await rejected;
  expect(provider.calls).toBe(2);
  expect(f.leases[1]?.fail).toHaveBeenCalledTimes(1);
  expect(f.leases[1]?.end).not.toHaveBeenCalled();
  expect(f.open()).toBe(0);
  wait.release();
});

test('provider errors during repair stop without another dispatch', async () => {
  const provider = new MockDecisionModel([invalid, { error: new Error('provider-canary') }, valid]);
  const f = fixture(provider, { repairs: 3 });
  await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
    code: 'unavailable',
    message: 'The requested service is unavailable.',
  });
  expect(provider.calls).toBe(2);
  expect(f.leases[1]?.fail).toHaveBeenCalledTimes(1);
  expect(f.leases[1]?.end).not.toHaveBeenCalled();
  expect(f.chat.calls).toBe(0);
});

test.each([null, { answers: {}, raw: 3 }, { raw: '{}' }, { answers: {}, raw: '{}', extra: true }])(
  'malformed result shapes are never repaired %#',
  async (value) => {
    const provider = new MockDecisionModel([{ invalid: value }, valid]);
    const f = fixture(provider, { repairs: 1 });
    await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(provider.calls).toBe(1);
    expect(f.leases[0]?.fail).toHaveBeenCalledTimes(1);
    expect(f.leases[0]?.end).not.toHaveBeenCalled();
  },
);

test('missing raw prevents repair but still settles the completed call', async () => {
  const provider = new MockDecisionModel([
    { answers: invalid.answers, usage: invalid.usage },
    valid,
  ]);
  const f = fixture(provider, { repairs: 1 });
  await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
    code: 'invalid',
  });
  expect(provider.calls).toBe(1);
  expect(f.begin).toHaveBeenCalledTimes(1);
  expect(f.leases[0]?.end).toHaveBeenCalledExactlyOnceWith(invalid.usage);
});

test.each([
  { private: true, consent: true },
  { private: false, consent: false },
])('labels and consent block structured decisions before invoking chat: %o', async (options) => {
  const provider = structured(valid.raw);
  const f = fixture(provider.model, { ...options, remote: true, repairs: 1 });
  await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
    code: 'denied',
  });
  expect(provider.chat.calls).toBe(0);
  expect(f.leases).toHaveLength(0);
  expect(f.consent).toHaveBeenCalledTimes(options.private ? 0 : 1);
});

test('public structured decisions use consent and return only answers', async () => {
  const provider = structured(valid.raw);
  const f = fixture(provider.model, { remote: true });
  expect(await f.host.langchain.decide('triage', request)).toEqual(valid.answers);
  expect(f.consent).toHaveBeenCalledTimes(1);
  expect(provider.chat.calls).toBe(1);
});

test('each repair reselects an available decision provider without a text dispatch', async () => {
  const provider = new MockDecisionModel([invalid]);
  const backup = new MockDecisionModel([valid]);
  const f = fixture(provider, {
    repairs: 1,
    backup,
    availability: ({ providerId }) => ({
      status: providerId === 'decision' && provider.calls > 0 ? 'unavailable' : 'available',
    }),
  });
  expect(await f.host.langchain.decide('triage', request)).toEqual(valid.answers);
  expect(provider.calls).toBe(1);
  expect(backup.recordedCalls[0]?.repair).toEqual({ attempt: 1, reply: invalid.raw });
  expect(f.leases).toHaveLength(2);
  expect(f.chat.calls).toBe(0);
  expect(f.open()).toBe(0);
});

test('live labels are rechecked before leasing a repair', async () => {
  const provider = new MockDecisionModel([invalid, valid]);
  const hook = vi.fn<OutputSafetyHook>(() => 'allow');
  const f = fixture(provider, { remote: true, repairs: 1, hook });
  hook.mockImplementation(() => {
    f.run.labels.add('private-user');
    return 'allow';
  });
  await expect(f.host.langchain.decide('triage', request)).rejects.toMatchObject({
    code: 'denied',
  });
  expect(provider.calls).toBe(1);
  expect(f.leases).toHaveLength(1);
  expect(f.leases[0]?.end).toHaveBeenCalledExactlyOnceWith(invalid.usage);
});
