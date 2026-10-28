// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test, vi } from 'vitest';
import { budgetLimits, RunBudget } from '../src/budgets.js';
import { ModelRouter, type ModelRun } from '../src/model-router.js';
import type {
  ModelConsentRequest,
  ModelDescriptor,
  ModelRoleRequirements,
  ModelRouting,
  ModelUsage,
} from '../src/models.js';
import { type BudgetLimits, type DataLabel, DEFAULT_DATA_POLICY } from '../src/policy.js';
import type { DiagnosticEvent } from '../src/runtime.js';
import { deferred, definition, flush } from './fake-executor.js';

const local: ModelDescriptor = {
  destination: 'in-browser',
  modality: 'text',
  features: ['streaming'],
  pricing: { inputPerToken: 0, outputPerToken: 0 },
};
const remote: ModelDescriptor = { ...local, destination: 'third-party' };
function configuration(
  providers: Record<string, ModelDescriptor> = { local },
  overrides: Partial<ModelRouting> = {},
): ModelRouting {
  return {
    providers,
    roles: {
      assistant: {
        providers: Object.keys(providers),
        allow: [...new Set(Object.values(providers).map((p) => p.destination))],
        maxTokens: 1000,
      },
    },
    ...overrides,
  };
}
function fixture(
  routing: ModelRouting = configuration(),
  limits: Partial<BudgetLimits> = {},
  requirements: ModelRoleRequirements = { modality: 'text' },
): {
  router: ModelRouter;
  run: ModelRun;
  controller: AbortController;
  diagnostics: Omit<DiagnosticEvent, 'instanceId'>[];
  stop(): void;
} {
  let active = true;
  const controller = new AbortController();
  const diagnostics: Omit<DiagnosticEvent, 'instanceId'>[] = [];
  const router = new ModelRouter(
    { ...definition, models: { assistant: requirements } },
    routing,
    DEFAULT_DATA_POLICY,
    (event) => diagnostics.push(event),
  );
  const run: ModelRun = {
    runId: 'run' as ModelRun['runId'],
    signal: controller.signal,
    labels: new Set<DataLabel>(),
    budget: new RunBudget(budgetLimits(limits)),
    active: () => active,
    failBudget: vi.fn(),
    selectedRouteChanged: vi.fn(),
  };
  return {
    router,
    run,
    controller,
    diagnostics,
    stop: () => {
      active = false;
      controller.abort();
    },
  };
}

test('selection uses the first eligible provider and local calls never request consent', async () => {
  const consent = vi.fn(() => true);
  const { router, run } = fixture(configuration({ first: local, second: local }, { consent }));
  expect(await router.port(run).begin('assistant')).toMatchObject({
    providerId: 'first',
    destination: 'in-browser',
  });
  expect(consent).not.toHaveBeenCalled();
});
test('selection skips missing features and languages and compares primary subtags', async () => {
  const providers = {
    missingFeature: { ...local, features: [] },
    missingLanguage: local,
    matching: { ...local, languages: ['EN-us'] },
  };
  const { router, run } = fixture(
    configuration(providers),
    {},
    { modality: 'text', requires: ['streaming'], languages: ['en'] },
  );
  expect(await router.port(run).begin('assistant')).toMatchObject({ providerId: 'matching' });
});
test.each(['labels', 'consent', 'features'] as const)(
  'AE3 %s exclusions choose the fixed denied or unavailable error',
  async (reason) => {
    const { router, run } = fixture(
      configuration({ remote: reason === 'features' ? { ...remote, features: [] } : remote }),
      {},
      { modality: 'text', requires: ['streaming'] },
    );
    if (reason === 'labels') run.labels.add('private-user');
    await expect(router.port(run).begin('assistant')).rejects.toMatchObject({
      code: reason === 'features' ? 'unavailable' : 'denied',
    });
    expect(run.selectedRouteChanged).not.toHaveBeenCalled();
  },
);
test('reservations are atomic across concurrent calls and tokens are checked first', async () => {
  const { router, run } = fixture(configuration(), { tokens: 1500 });
  const first = await router.port(run).begin('assistant');
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({
    code: 'budget_exceeded',
    budget: 'tokens',
  });
  expect(run.failBudget).toHaveBeenCalledWith('tokens');
  first.end({ inputTokens: 1, outputTokens: 1 });
  expect(await router.port(run).begin('assistant')).toMatchObject({ providerId: 'local' });
});
test.each(['known', 'unknown'] as const)(
  '%s pricing reserves cost before dispatch',
  async (kind) => {
    const routing = configuration({
      local: {
        ...local,
        pricing: kind === 'known' ? { inputPerToken: 0.003, outputPerToken: 0.005 } : 'unknown',
      },
    });
    const configured =
      kind === 'unknown'
        ? {
            ...routing,
            roles: {
              assistant: {
                providers: ['local'],
                allow: ['in-browser'] as const,
                maxTokens: 1000,
                maxCost: 5,
              },
            },
          }
        : routing;
    const { router, run } = fixture(configured, { cost: 7 });
    const first = await router.port(run).begin('assistant');
    first.end();
    await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ budget: 'cost' });
    expect(run.failBudget).toHaveBeenCalledWith('cost');
  },
);
test('known zero pricing permits a zero cost limit', async () => {
  const { router, run } = fixture();
  expect(await router.port(run).begin('assistant')).toMatchObject({ providerId: 'local' });
});
test('valid usage replaces the reservation with actual token and cost charges', async () => {
  const { router, run } = fixture(
    configuration({ local: { ...local, pricing: { inputPerToken: 1, outputPerToken: 2 } } }),
    { tokens: 1200, cost: 2400 },
  );
  const call = await router.port(run).begin('assistant');
  call.end({ inputTokens: 100, outputTokens: 100 });
  expect(await router.port(run).begin('assistant')).toMatchObject({ providerId: 'local' });
});
test.each([
  undefined,
  { inputTokens: -1, outputTokens: 1 },
  { inputTokens: NaN, outputTokens: 1 },
  { inputTokens: 1.5, outputTokens: 1 },
  { inputTokens: '1', outputTokens: 1 },
])('invalid or missing usage charges the reservation: %j', async (usage) => {
  const { router, run } = fixture(configuration(), { tokens: 1500 });
  const call = await router.port(run).begin('assistant');
  call.end(usage as ModelUsage | undefined);
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ budget: 'tokens' });
});
test('fail charges once even when end and fail are called again', async () => {
  const { router, run } = fixture(configuration(), { tokens: 2000 });
  const call = await router.port(run).begin('assistant');
  call.fail();
  call.end({ inputTokens: 0, outputTokens: 0 });
  call.fail();
  const second = await router.port(run).begin('assistant');
  second.end({ inputTokens: 0, outputTokens: 0 });
  expect(await router.port(run).begin('assistant')).toMatchObject({ providerId: 'local' });
});
test.each(['tokens', 'cost'] as const)(
  'usage above the reservation fails the run on %s',
  async (budget) => {
    const pricing = budget === 'cost' ? { inputPerToken: 1, outputPerToken: 1 } : local.pricing;
    const { router, run } = fixture(configuration({ local: { ...local, pricing } }), {
      tokens: budget === 'tokens' ? 1000 : 3000,
      cost: 1000,
    });
    const call = await router.port(run).begin('assistant');
    call.end({ inputTokens: 1000, outputTokens: 1 });
    expect(run.failBudget).toHaveBeenCalledWith(budget);
  },
);
test('settlement after the run ends changes nothing', async () => {
  const { router, run, stop } = fixture(configuration(), { tokens: 1000 });
  const call = await router.port(run).begin('assistant');
  stop();
  call.end({ inputTokens: 1001, outputTokens: 0 });
  call.fail();
  expect(run.failBudget).not.toHaveBeenCalled();
});

test('concurrent consent shares one decision and remembers approval by role and class', async () => {
  const answer = deferred<boolean>();
  const consent = vi.fn(() => answer.promise);
  const { router, run } = fixture(configuration({ remote, remote2: remote }, { consent }));
  const first = router.port(run).begin('assistant');
  const second = router.port(run).begin('assistant');
  await flush();
  expect(consent).toHaveBeenCalledTimes(1);
  expect(consent.mock.calls[0]).toBeDefined();
  answer.resolve(true);
  expect(await first).toMatchObject({ providerId: 'remote' });
  await second;
  await router.port(run).begin('assistant');
  expect(consent).toHaveBeenCalledTimes(1);
});
test('consent carries ordered class providers and the previously dispatched route', async () => {
  const requests: ModelConsentRequest[] = [];
  const routing = configuration(
    { local, remote, host: { ...local, destination: 'host-server' }, remote2: remote },
    {
      consent: (request) => {
        requests.push(request);
        return true;
      },
    },
  );
  const { run } = fixture();
  const policy = {
    ...DEFAULT_DATA_POLICY,
    app: { allow: ['third-party', 'host-server'] as const },
  };
  const router = new ModelRouter(
    { ...definition, models: { assistant: { modality: 'text' } } },
    routing,
    policy,
    () => {},
  );
  await router.port(run).begin('assistant');
  run.labels.add('app');
  await router.port(run).begin('assistant');
  expect(requests).toMatchObject([
    {
      role: 'assistant',
      destination: 'third-party',
      providers: ['remote', 'remote2'],
      previous: { providerId: 'local', destination: 'in-browser' },
    },
  ]);
});
test('a remembered refusal skips that class and uses the next provider', async () => {
  const consent = vi.fn(() => false);
  const { router, run } = fixture(configuration({ remote, remote2: remote, local }, { consent }));
  expect(await router.port(run).begin('assistant')).toMatchObject({ providerId: 'local' });
  await router.port(run).begin('assistant');
  expect(consent).toHaveBeenCalledTimes(1);
});
test.each(['throw', 'nonboolean'] as const)(
  'a %s consent answer refuses only the waiting calls and later asks again',
  async (kind) => {
    const consent = vi
      .fn()
      .mockImplementationOnce(() => {
        if (kind === 'throw') throw new Error('host failure');
        return 'yes';
      })
      .mockResolvedValue(true);
    const { router, run, diagnostics } = fixture(configuration({ remote }, { consent }));
    await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ code: 'denied' });
    expect(diagnostics).toMatchObject([{ kind: 'model_failed' }]);
    expect(await router.port(run).begin('assistant')).toMatchObject({ providerId: 'remote' });
    expect(consent).toHaveBeenCalledTimes(2);
  },
);
test('without a callback host-server counts as refused', async () => {
  const { router, run } = fixture(
    configuration({ host: { ...local, destination: 'host-server' } }),
  );
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ code: 'denied' });
});
test('R7 cancellation aborts an unobserved consent request and permits a later request', async () => {
  const requests: ModelConsentRequest[] = [];
  const answer = deferred<boolean>();
  const { router, run, stop } = fixture(
    configuration(
      { remote },
      {
        consent: (request) => {
          requests.push(request);
          return answer.promise;
        },
      },
    ),
    { tokens: 1000 },
  );
  const waiting = router.port(run).begin('assistant');
  await flush();
  stop();
  await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
  expect(requests[0]?.signal.aborted).toBe(true);
  expect(run.selectedRouteChanged).not.toHaveBeenCalled();
  // No reservation was made while consent was pending.
  expect(() => run.budget.reserveModel(1000, 0)).not.toThrow();
  const next = {
    ...run,
    signal: new AbortController().signal,
    active: () => true,
    budget: new RunBudget(budgetLimits()),
  };
  const later = router.port(next).begin('assistant');
  await flush();
  expect(requests).toHaveLength(2);
  answer.resolve(true);
  expect(await later).toMatchObject({ providerId: 'remote' });
});
test('one cancelled waiter leaves shared consent alive for another run', async () => {
  const answer = deferred<boolean>();
  const requests: ModelConsentRequest[] = [];
  const { router, run, stop } = fixture(
    configuration(
      { remote },
      {
        consent: (request) => {
          requests.push(request);
          return answer.promise;
        },
      },
    ),
  );
  const first = router.port(run).begin('assistant');
  const secondRun = { ...run, signal: new AbortController().signal, active: () => true };
  const second = router.port(secondRun).begin('assistant');
  await flush();
  stop();
  await expect(first).rejects.toMatchObject({ code: 'cancelled' });
  expect(requests[0]?.signal.aborted).toBe(false);
  answer.resolve(true);
  expect(await second).toMatchObject({ providerId: 'remote' });
});
test.each([true, false])(
  'R8 label narrowing during consent selects local when available: %s',
  async (fallback) => {
    const answer = deferred<boolean>();
    const { router, run } = fixture(
      configuration(fallback ? { remote, local } : { remote }, { consent: () => answer.promise }),
    );
    const waiting = router.port(run).begin('assistant');
    await flush();
    run.labels.add('private-user');
    answer.resolve(true);
    if (fallback) expect(await waiting).toMatchObject({ providerId: 'local' });
    else await expect(waiting).rejects.toMatchObject({ code: 'denied' });
    expect(run.selectedRouteChanged).not.toHaveBeenCalledWith('assistant', {
      providerId: 'remote',
      destination: 'third-party',
    });
  },
);
test.each(['label', 'end'] as const)(
  'R8 %s during a credential wait releases the reservation and publishes no route',
  async (reason) => {
    const credential = deferred<string>();
    const getCredential = vi.fn(() => credential.promise);
    const { router, run, stop } = fixture(
      configuration(
        { host: { ...local, destination: 'host-server', credential: true } },
        { consent: () => true, getCredential },
      ),
      { tokens: 1000 },
    );
    const waiting = router.port(run).begin('assistant');
    await flush();
    expect(getCredential).toHaveBeenCalledTimes(1);
    expect(() => run.budget.reserveModel(1, 0)).toThrowError(
      expect.objectContaining({ budget: 'tokens' }),
    );
    if (reason === 'label') {
      run.labels.add('private-user');
      credential.resolve('canary');
    } else stop();
    await expect(waiting).rejects.toMatchObject({
      code: reason === 'label' ? 'denied' : 'cancelled',
    });
    expect(() => run.budget.reserveModel(1000, 0)).not.toThrow();
    expect(run.selectedRouteChanged).not.toHaveBeenCalled();
    credential.resolve('late canary');
  },
);
test('a credential is fetched once after reservation and lives only on its call lease', async () => {
  const getCredential = vi.fn(() => 'canary-credential-5e1d');
  const { router, run, diagnostics } = fixture(
    configuration({ local: { ...local, credential: true } }, { getCredential }),
  );
  const call = await router.port(run).begin('assistant');
  expect(call.credential).toBe('canary-credential-5e1d');
  expect(getCredential).toHaveBeenCalledExactlyOnceWith({ role: 'assistant', providerId: 'local' });
  expect(
    JSON.stringify([diagnostics, router.summary, vi.mocked(run.selectedRouteChanged).mock.calls]),
  ).not.toContain('canary-credential-5e1d');
});
test.each(['throw', '', 42] as const)(
  'credential failures release reservations and redact diagnostics: %s',
  async (result) => {
    const getCredential = vi.fn(() => {
      if (result === 'throw') throw new Error('canary-credential-5e1d');
      return result;
    });
    const { router, run, diagnostics } = fixture(
      configuration(
        { local: { ...local, credential: true } },
        { getCredential: getCredential as never },
      ),
      { tokens: 1000 },
    );
    await expect(router.port(run).begin('assistant')).rejects.toMatchObject({
      code: 'unavailable',
      message: 'The requested service is unavailable.',
    });
    expect(() => run.budget.reserveModel(1000, 0)).not.toThrow();
    expect(diagnostics).toEqual([{ kind: 'model_failed', runId: 'run' }]);
    expect(JSON.stringify(diagnostics)).not.toContain('canary-credential-5e1d');
  },
);
test('dispose aborts pending consent and prevents any later dispatch', async () => {
  const answer = deferred<boolean>();
  let signal: AbortSignal | undefined;
  const { router, run } = fixture(
    configuration(
      { remote },
      {
        consent: (request) => {
          signal = request.signal;
          return answer.promise;
        },
      },
    ),
  );
  const waiting = router.port(run).begin('assistant');
  await flush();
  router.dispose();
  answer.resolve(true);
  await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
  expect(signal?.aborted).toBe(true);
});

test('no declared roles and no configuration is valid', () => {
  const router = new ModelRouter(definition, undefined, DEFAULT_DATA_POLICY, () => {});
  expect(router.summary).toEqual({ roles: [], providers: {} });
});
const invalidConfigurations: Array<[string, (config: ModelRouting) => unknown]> = [
  ['missing role', (config) => ({ ...config, roles: {} })],
  [
    'extra role',
    (config) => ({ ...config, roles: { ...config.roles, secretRole: config.roles['assistant'] } }),
  ],
  ['provider ID', (config) => ({ ...config, providers: { 'secret/provider': local } })],
  [
    'unknown provider',
    (config) => ({
      ...config,
      roles: { assistant: { ...config.roles['assistant'], providers: ['secretProvider'] } },
    }),
  ],
  [
    'empty list',
    (config) => ({
      ...config,
      roles: { assistant: { ...config.roles['assistant'], providers: [] } },
    }),
  ],
  [
    'outside allow',
    (config) => ({ ...config, roles: { assistant: { ...config.roles['assistant'], allow: [] } } }),
  ],
  ...['destination', 'modality', 'features', 'languages', 'pricing', 'credential'].map(
    (field) =>
      [
        field,
        (config: ModelRouting) => ({
          ...config,
          providers: {
            local: {
              ...local,
              [field]:
                field === 'features'
                  ? ['secret-feature']
                  : field === 'languages'
                    ? [42]
                    : field === 'pricing'
                      ? { inputPerToken: -1, outputPerToken: 0 }
                      : 'secret-value',
            },
          },
        }),
      ] as [string, (config: ModelRouting) => unknown],
  ),
  ...[0, -1, 1.5, Infinity, NaN].map(
    (maxTokens) =>
      [
        'maxTokens',
        (config: ModelRouting) => ({
          ...config,
          roles: { assistant: { ...config.roles['assistant'], maxTokens } },
        }),
      ] as [string, (config: ModelRouting) => unknown],
  ),
  ...[-1, Infinity, NaN, 0].map(
    (maxCost) =>
      [
        'maxCost with known price',
        (config: ModelRouting) => ({
          ...config,
          roles: { assistant: { ...config.roles['assistant'], maxCost } },
        }),
      ] as [string, (config: ModelRouting) => unknown],
  ),
  [
    'missing unknown cost',
    (config) => ({ ...config, providers: { local: { ...local, pricing: 'unknown' } } }),
  ],
  ['bad consent', (config) => ({ ...config, consent: 1 })],
  ['bad credential callback', (config) => ({ ...config, getCredential: 1 })],
  [
    'missing credential callback',
    (config) => ({ ...config, providers: { local: { ...local, credential: true } } }),
  ],
];
test.each(invalidConfigurations)(
  'configuration rejects %s with no configuration data in the fixed error',
  (_name, invalidate) => {
    expect(() => fixture(invalidate(configuration()) as ModelRouting)).toThrowError(
      expect.objectContaining({ code: 'invalid', message: 'The request is invalid.' }),
    );
  },
);
test.each([-1, Infinity, NaN])('malformed provider price %s rejects invalid', (price) => {
  expect(() =>
    fixture(
      configuration({ local: { ...local, pricing: { inputPerToken: 0, outputPerToken: price } } }),
    ),
  ).toThrowError(expect.objectContaining({ code: 'invalid' }));
});
test('configuration is copied before hosts can mutate descriptors and routes', async () => {
  const providers = { local: { ...local, features: ['streaming'] as ModelDescriptor['features'] } };
  const list = ['local'];
  const config = configuration(providers, {
    roles: { assistant: { providers: list, allow: ['in-browser'], maxTokens: 1000 } },
  });
  const { router, run } = fixture(config);
  providers.local.destination = 'third-party';
  list.splice(0);
  expect(await router.port(run).begin('assistant')).toMatchObject({
    providerId: 'local',
    destination: 'in-browser',
  });
});

test('caller cancellation after dispatch charges the reservation rather than reported usage', async () => {
  const { router, run } = fixture(configuration(), { tokens: 1500 });
  const caller = new AbortController();
  const call = await router.port(run).begin('assistant', { signal: caller.signal });
  caller.abort();
  call.end({ inputTokens: 0, outputTokens: 0 });
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ budget: 'tokens' });
});
test('multiple roles can share a routed provider without changing implementation requirements', () => {
  const routing = configuration();
  const router = new ModelRouter(
    { ...definition, models: { assistant: { modality: 'text' }, second: { modality: 'text' } } },
    {
      ...routing,
      roles: {
        ...routing.roles,
        second: { providers: ['local'], allow: ['in-browser'], maxTokens: 1000 },
      },
    },
    DEFAULT_DATA_POLICY,
    () => {},
  );
  expect(router.summary).toEqual({
    roles: ['assistant', 'second'],
    providers: { local: { credential: false } },
  });
});

test('a consent answer racing the last waiter cancellation is forgotten', async () => {
  const answer = deferred<boolean>();
  const consent = vi.fn(() => answer.promise);
  const { router, run, stop } = fixture(configuration({ remote }, { consent }));
  const waiting = router.port(run).begin('assistant');
  await flush();
  stop();
  answer.resolve(true);
  await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
  const next = { ...run, signal: new AbortController().signal, active: () => true };
  expect(await router.port(next).begin('assistant')).toMatchObject({ providerId: 'remote' });
  expect(consent).toHaveBeenCalledTimes(2);
});
test('a synchronous route-notice cancellation releases the lease before dispatch', async () => {
  const { router, run, controller } = fixture(configuration(), { tokens: 1000 });
  vi.mocked(run.selectedRouteChanged).mockImplementation(() => controller.abort());
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ code: 'cancelled' });
  expect(() => run.budget.reserveModel(1000, 0)).not.toThrow();
});
