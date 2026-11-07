// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { budgetLimits, RunBudget } from '../src/budgets.js';
import { ModelRouter, type ModelRun } from '../src/model-router.js';
import type {
  ModelDescriptor,
  ModelRoleRequirements,
  ModelRouting,
  ModelUsage,
} from '../src/models.js';
import { type BudgetLimits, type DataLabel, DEFAULT_DATA_POLICY } from '../src/policy.js';
import { deferred, definition, flush } from './fake-executor.js';

const decision: ModelDescriptor = {
  modality: 'decision',
  destination: 'in-browser',
  features: ['cancellation'],
  pricing: { inputPerToken: 1, outputPerToken: 2 },
};
const text: ModelDescriptor = { ...decision, modality: 'text' };

function fixture(overrides: Partial<ModelRouting> = {}, limits: Partial<BudgetLimits> = {}) {
  const routing: ModelRouting = {
    providers: { decision, text },
    roles: {
      triage: {
        providers: ['decision'],
        allow: ['in-browser'],
        maxTokens: 10,
        repairAttempts: 1,
      },
      assistant: { providers: ['text'], allow: ['in-browser'], maxTokens: 10, repairAttempts: 1 },
    },
    ...overrides,
  };
  const router = new ModelRouter(
    {
      ...definition,
      models: {
        triage: { modality: 'decision' },
        assistant: { modality: 'text' },
      },
    },
    routing,
    DEFAULT_DATA_POLICY,
    () => {},
  );
  const controller = new AbortController();
  const run: ModelRun = {
    runId: 'run' as ModelRun['runId'],
    signal: controller.signal,
    labels: new Set<DataLabel>(),
    budget: new RunBudget(budgetLimits({ cost: 200, ...limits })),
    active: () => true,
    failBudget: vi.fn(),
    selectedRouteChanged: vi.fn(),
  };
  return { router, run, controller, port: router.port(run) };
}

test.each(['decision', 'text'] as const)(
  'preparation rejects a %s role listing the opposite modality',
  (modality) => {
    const requirements: ModelRoleRequirements = { modality };
    const availability = vi.fn();
    expect(
      () =>
        new ModelRouter(
          { ...definition, models: { role: requirements } },
          {
            providers: { wrong: modality === 'decision' ? text : decision },
            roles: { role: { providers: ['wrong'], allow: ['in-browser'], maxTokens: 1 } },
            availability,
          },
          DEFAULT_DATA_POLICY,
          () => {},
        ),
    ).toThrowError(expect.objectContaining({ code: 'invalid' }));
    expect(availability).not.toHaveBeenCalled();
  },
);

test('selection and repair keep both roles in their own modality', async () => {
  const { router, port } = fixture();
  expect(router.summary.decisionRoles).toEqual(['triage']);
  expect(router.summary.providers['decision']).toEqual({ credential: false, modality: 'decision' });
  expect(router.summary.providers['text']).toEqual({ credential: false });
  for (const options of [undefined, { repairAttempt: 1 }]) {
    const chosen = await port.begin('triage', options);
    expect(chosen.providerId).toBe('decision');
    chosen.end({ inputTokens: 1, outputTokens: 0 });
    const chat = await port.begin('assistant', options);
    expect(chat.providerId).toBe('text');
    chat.end({ inputTokens: 1, outputTokens: 1 });
  }
});

test.each(['decision', 'text'] as const)(
  'unavailable %s never falls across modality',
  async (modality) => {
    const availability = vi.fn(({ providerId }: { providerId: string }) => ({
      status: providerId === modality ? ('unavailable' as const) : ('available' as const),
    }));
    const { port } = fixture({ availability });
    await expect(
      port.begin(modality === 'decision' ? 'triage' : 'assistant'),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(availability).toHaveBeenCalledTimes(1);
    expect(availability.mock.calls[0]?.[0].providerId).toBe(modality);
  },
);

test('download consent and readiness stay on the decision provider', async () => {
  let ready = false;
  const availability = vi.fn(() =>
    ready
      ? { status: 'available' as const }
      : { status: 'downloadable' as const, siteStorage: false },
  );
  const download = vi.fn(() => {
    ready = true;
    return true;
  });
  const { port } = fixture({ availability, download });
  const lease = await port.begin('triage');
  expect(lease.providerId).toBe('decision');
  expect(download).toHaveBeenCalledTimes(1);
  expect(availability).toHaveBeenCalledTimes(2);
  lease.fail();
});

test('private-user policy blocks a listed and previously consented third-party decision', async () => {
  const consent = vi.fn(() => true);
  const { port, run } = fixture({
    providers: { decision: { ...decision, destination: 'third-party' }, text },
    roles: {
      triage: { providers: ['decision'], allow: ['third-party'], maxTokens: 10 },
      assistant: { providers: ['text'], allow: ['in-browser'], maxTokens: 10 },
    },
    consent,
  });
  (await port.begin('triage')).end();
  run.labels.add('private-user');
  await expect(port.begin('triage')).rejects.toMatchObject({ code: 'denied' });
  expect(consent).toHaveBeenCalledTimes(1);
  expect(run.selectedRouteChanged).toHaveBeenCalledTimes(1);
});

test('labels gained while waiting for consent prevent decision lease issuance', async () => {
  const answer = deferred<boolean>();
  const { port, run } = fixture({
    providers: { decision: { ...decision, destination: 'third-party' }, text },
    roles: {
      triage: { providers: ['decision'], allow: ['third-party'], maxTokens: 10 },
      assistant: { providers: ['text'], allow: ['in-browser'], maxTokens: 10 },
    },
    consent: () => answer.promise,
  });
  const pending = port.begin('triage');
  await flush();
  run.labels.add('private-user');
  answer.resolve(true);
  await expect(pending).rejects.toMatchObject({ code: 'denied' });
  expect(run.selectedRouteChanged).not.toHaveBeenCalled();
});

test('decision reservations precede dispatch and input-only usage replaces them exactly once', async () => {
  const { port, run } = fixture({}, { tokens: 13, cost: 23 });
  const reserve = vi.spyOn(run.budget, 'reserveModel');
  const lease = await port.begin('triage');
  expect(reserve).toHaveBeenCalledExactlyOnceWith(10, 20);
  lease.end({ inputTokens: 3, outputTokens: 0 });
  lease.fail();
  lease.end({ inputTokens: 30, outputTokens: 0 });
  (await port.begin('triage')).fail();
  await expect(port.begin('triage')).rejects.toMatchObject({ budget: 'tokens' });
});

test.each([undefined, { inputTokens: NaN, outputTokens: 0 }, { inputTokens: -1, outputTokens: 0 }])(
  'missing or invalid decision usage charges the reservation %#',
  async (usage) => {
    const { port } = fixture({}, { tokens: 19, cost: 100 });
    (await port.begin('triage')).end(usage as ModelUsage | undefined);
    await expect(port.begin('triage')).rejects.toMatchObject({ budget: 'tokens' });
  },
);

test('failed decision charges once and does not select a fallback', async () => {
  const { port, run } = fixture({}, { tokens: 19, cost: 100 });
  const lease = await port.begin('triage');
  lease.fail();
  lease.fail();
  lease.end();
  expect(run.selectedRouteChanged).toHaveBeenCalledTimes(1);
  await expect(port.begin('triage')).rejects.toMatchObject({ budget: 'tokens' });
});

test('unknown pricing uses maxCost and over-budget usage fails the run', async () => {
  const unknown = fixture(
    {
      providers: { decision: { ...decision, pricing: 'unknown' }, text },
      roles: {
        triage: { providers: ['decision'], allow: ['in-browser'], maxTokens: 10, maxCost: 7 },
        assistant: { providers: ['text'], allow: ['in-browser'], maxTokens: 10 },
      },
    },
    { cost: 13 },
  );
  (await unknown.port.begin('triage')).end({ inputTokens: 1, outputTokens: 0 });
  await expect(unknown.port.begin('triage')).rejects.toMatchObject({ budget: 'cost' });
  const { port, run } = fixture({}, { tokens: 10, cost: 100 });
  (await port.begin('triage')).end({ inputTokens: 11, outputTokens: 0 });
  expect(run.failBudget).toHaveBeenCalledExactlyOnceWith('tokens');
});

test('decision consent is shared while credentials are acquired afresh per call', async () => {
  const consent = vi.fn(() => true);
  const getCredential = vi.fn(() => 'ephemeral-credential');
  const { port, run } = fixture({
    providers: {
      decision: { ...decision, destination: 'host-server', credential: true },
      text,
    },
    roles: {
      triage: { providers: ['decision'], allow: ['host-server'], maxTokens: 10 },
      assistant: { providers: ['text'], allow: ['in-browser'], maxTokens: 10 },
    },
    consent,
    getCredential,
  });
  const leases = await Promise.all([port.begin('triage'), port.begin('triage')]);
  for (const lease of leases) {
    expect(lease.credential).toBe('ephemeral-credential');
    lease.end();
  }
  expect(consent).toHaveBeenCalledTimes(1);
  expect(getCredential).toHaveBeenCalledTimes(2);
  expect(run.selectedRouteChanged).toHaveBeenCalledTimes(2);
});
