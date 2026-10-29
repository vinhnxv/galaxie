// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, test, vi } from 'vitest';
import { budgetLimits, RunBudget } from '../src/budgets.js';
import { ModelRouter, type ModelRun } from '../src/model-router.js';
import type {
  ModelAvailability,
  ModelDescriptor,
  ModelDownloadRequest,
  ModelRouting,
} from '../src/models.js';
import { DEFAULT_DATA_POLICY } from '../src/policy.js';
import type { DiagnosticEvent } from '../src/runtime.js';
import { deferred, definition, flush } from './fake-executor.js';

const local: ModelDescriptor = {
  destination: 'in-browser',
  modality: 'text',
  features: ['streaming'],
  pricing: { inputPerToken: 0, outputPerToken: 0 },
};
const remote: ModelDescriptor = { ...local, destination: 'third-party' };
const downloadable: ModelAvailability = { status: 'downloadable', bytes: 123, siteStorage: true };
function fixture(
  hooks: Partial<ModelRouting> = {},
  providers: Record<string, ModelDescriptor> = { builtin: local, webllm: local, remote },
): {
  router: ModelRouter;
  run: ModelRun;
  controller: AbortController;
  diagnostics: Omit<DiagnosticEvent, 'instanceId'>[];
} {
  const controller = new AbortController();
  const diagnostics: Omit<DiagnosticEvent, 'instanceId'>[] = [];
  const router = new ModelRouter(
    { ...definition, models: { assistant: { modality: 'text' } } },
    {
      providers,
      roles: {
        assistant: {
          providers: Object.keys(providers),
          allow: ['in-browser', 'third-party'],
          maxTokens: 1000,
        },
      },
      ...hooks,
    },
    DEFAULT_DATA_POLICY,
    (event) => diagnostics.push(event),
  );
  const run: ModelRun = {
    runId: 'run' as ModelRun['runId'],
    signal: controller.signal,
    labels: new Set(),
    budget: new RunBudget(budgetLimits({ tokens: 1000 })),
    active: () => !controller.signal.aborted,
    failBudget: vi.fn(),
    selectedRouteChanged: vi.fn(),
  };
  return { router, run, controller, diagnostics };
}
afterEach(() => vi.unstubAllGlobals());

test('cached browser provider wins before downloads or remote consent', async () => {
  const download = vi.fn(() => true);
  const consent = vi.fn(() => true);
  const availability = vi.fn(({ providerId }) =>
    providerId === 'builtin' ? downloadable : { status: 'available' as const },
  );
  const { router, run } = fixture({ availability, download, consent });
  expect(await router.port(run).begin('assistant')).toMatchObject({ providerId: 'webllm' });
  expect(download).not.toHaveBeenCalled();
  expect(consent).not.toHaveBeenCalled();
  expect(availability.mock.calls.map(([request]) => request.providerId)).toEqual([
    'builtin',
    'webllm',
  ]);
});

test('downloads retain route order and precede deferred remote consent', async () => {
  const decisions: string[] = [];
  const { router, run } = fixture({
    availability: ({ providerId }) =>
      providerId === 'remote' ? { status: 'available' } : downloadable,
    download: ({ providerId }) => {
      decisions.push(providerId);
      return false;
    },
    consent: () => {
      decisions.push('consent');
      return true;
    },
  });
  expect(await router.port(run).begin('assistant')).toMatchObject({ providerId: 'remote' });
  expect(decisions).toEqual(['builtin', 'webllm', 'consent']);
});

test('remote first remains host policy when no earlier download exists', async () => {
  const consent = vi.fn(() => true);
  const { router, run } = fixture(
    { consent, availability: () => ({ status: 'available' }) },
    { remote, local },
  );
  expect(await router.port(run).begin('assistant')).toMatchObject({ providerId: 'remote' });
  expect(consent).toHaveBeenCalledTimes(1);
});

test.each(['available', 'downloadable'] as const)(
  'successful download re-probes and continues only for %s',
  async (status) => {
    const availability = vi
      .fn()
      .mockReturnValueOnce(downloadable)
      .mockReturnValueOnce({ status: 'available' })
      .mockReturnValueOnce(status === 'available' ? { status } : downloadable);
    const download = vi.fn(() => true);
    const { router, run } = fixture(
      { availability, download, consent: () => true },
      { builtin: local, remote },
    );
    expect(await router.port(run).begin('assistant')).toMatchObject({
      providerId: status === 'available' ? 'builtin' : 'remote',
    });
    expect(availability.mock.calls.map(([request]) => request.providerId)).toEqual([
      'builtin',
      'remote',
      'builtin',
    ]);
    expect(download).toHaveBeenCalledTimes(1);
  },
);

test.each(['false', 'invalid', 'null', 'undefined', 'throw', 'reject'] as const)(
  'download %s is remembered as refusal',
  async (kind) => {
    const error = new Error('private host failure');
    const download = vi.fn(() => {
      if (kind === 'throw') throw error;
      if (kind === 'reject') return Promise.reject(error);
      return kind === 'invalid'
        ? 'yes'
        : kind === 'null'
          ? null
          : kind === 'undefined'
            ? undefined
            : false;
    });
    const { router, run, diagnostics } = fixture(
      {
        availability: () => downloadable,
        download: download as unknown as NonNullable<ModelRouting['download']>,
      },
      { builtin: local },
    );
    for (let i = 0; i < 2; i++)
      await expect(router.port(run).begin('assistant')).rejects.toMatchObject({
        code: 'denied',
      });
    expect(download).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual(
      ['invalid', 'null', 'undefined'].includes(kind)
        ? [{ kind: 'model_failed', runId: run.runId }]
        : kind === 'throw' || kind === 'reject'
          ? [{ kind: 'model_failed', runId: run.runId, error }]
          : [],
    );
  },
);

test('concurrent calls share download, and only the last cancellation aborts it', async () => {
  const answer = deferred<boolean>();
  const requests: ModelDownloadRequest[] = [];
  const { router, run } = fixture(
    {
      availability: () => downloadable,
      download: (request) => {
        requests.push(request);
        return answer.promise;
      },
    },
    { builtin: local },
  );
  const firstController = new AbortController();
  const secondController = new AbortController();
  const first = router.port(run).begin('assistant', { signal: firstController.signal });
  const second = router.port(run).begin('assistant', { signal: secondController.signal });
  await flush();
  expect(requests).toHaveLength(1);
  firstController.abort();
  await expect(first).rejects.toMatchObject({ code: 'cancelled' });
  expect(requests[0]?.signal.aborted).toBe(false);
  secondController.abort();
  await expect(second).rejects.toMatchObject({ code: 'cancelled' });
  expect(requests[0]?.signal.aborted).toBe(true);
  expect(() => run.budget.reserveModel(1000, 0)).not.toThrow();
  answer.resolve(false);
});

test('successful shared download serves every waiter without remembering success', async () => {
  const answer = deferred<boolean>();
  let ready = false;
  const download = vi.fn(() => answer.promise);
  const { router, run } = fixture(
    { availability: () => (ready ? { status: 'available' } : downloadable), download },
    { builtin: local },
  );
  const nextRun = { ...run, budget: new RunBudget(budgetLimits()) };
  const first = router.port(run).begin('assistant');
  const second = router.port(nextRun).begin('assistant');
  await flush();
  ready = true;
  answer.resolve(true);
  (await first).end({ inputTokens: 0, outputTokens: 0 });
  (await second).end({ inputTokens: 0, outputTokens: 0 });
  expect(download).toHaveBeenCalledTimes(1);
  ready = false;
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ code: 'unavailable' });
  expect(download).toHaveBeenCalledTimes(2);
});

test.each(['available', 'missing', 'reject'] as const)(
  'site persistence is lazy and shared with API %s',
  async (kind) => {
    const persist = vi.fn(() =>
      kind === 'reject' ? Promise.reject(new Error('storage failure')) : Promise.resolve(true),
    );
    vi.stubGlobal('navigator', kind === 'missing' ? {} : { storage: { persist } });
    const results: boolean[] = [];
    const { router, run } = fixture(
      {
        availability: () => downloadable,
        download: async (request) => {
          expect(persist).toHaveBeenCalledTimes(
            results.length === 0 ? 0 : kind === 'missing' ? 0 : 1,
          );
          expect(request.bytes).toBe(123);
          if (request.persist === undefined) throw new Error('Missing site persistence hook');
          results.push(await request.persist());
          return false;
        },
      },
      { builtin: local, webllm: local },
    );
    await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ code: 'denied' });
    expect(results).toEqual([kind === 'available', kind === 'available']);
    expect(persist).toHaveBeenCalledTimes(kind === 'missing' ? 0 : 1);
  },
);

test('browser-managed downloads omit persist and unknown bytes', async () => {
  const download = vi.fn((_request: ModelDownloadRequest) => false);
  const { router, run } = fixture(
    { availability: () => ({ status: 'downloadable', siteStorage: false }), download },
    { builtin: local },
  );
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ code: 'denied' });
  expect(download.mock.calls[0]?.[0]).not.toHaveProperty('persist');
  expect(download.mock.calls[0]?.[0]).not.toHaveProperty('bytes');
});

test('persist resolves false on waiter cancellation while the storage API is pending', async () => {
  const storage = deferred<boolean>();
  vi.stubGlobal('navigator', { storage: { persist: () => storage.promise } });
  let persistence: Promise<boolean> | undefined;
  const { router, run, controller } = fixture(
    {
      availability: () => downloadable,
      download: (request) => {
        if (request.persist === undefined) throw new Error('Missing site persistence hook');
        persistence = request.persist();
        return persistence;
      },
    },
    { builtin: local },
  );
  const waiting = router.port(run).begin('assistant');
  await flush();
  controller.abort();
  await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
  expect(await persistence).toBe(false);
  storage.resolve(true);
});

test.each([
  'throw',
  'reject',
  'negative',
  'fraction',
  'unsafe',
  'missingStorage',
  'unknown',
  'null',
] as const)('invalid availability %s is unavailable with host-only diagnostics', async (kind) => {
  const error = new Error('private host failure');
  const availability = () => {
    if (kind === 'throw') throw error;
    if (kind === 'reject') return Promise.reject(error);
    return kind === 'negative'
      ? { ...downloadable, bytes: -1 }
      : kind === 'fraction'
        ? { ...downloadable, bytes: 1.5 }
        : kind === 'unsafe'
          ? { ...downloadable, bytes: Number.MAX_SAFE_INTEGER + 1 }
          : kind === 'missingStorage'
            ? { status: 'downloadable' }
            : kind === 'unknown'
              ? { status: 'secret' }
              : null;
  };
  const { router, run, diagnostics } = fixture(
    { availability: availability as NonNullable<ModelRouting['availability']> },
    { builtin: local },
  );
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(diagnostics).toEqual([
    {
      kind: 'model_failed',
      runId: run.runId,
      ...(kind === 'throw' || kind === 'reject' ? { error } : {}),
    },
  ]);
});

test('non-browser downloadable answers are unavailable without asking to download', async () => {
  const download = vi.fn(() => true);
  const { router, run } = fixture({ availability: () => downloadable, download }, { remote });
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ code: 'unavailable' });
  expect(download).not.toHaveBeenCalled();
});

test('a downloadable provider without a download hook is unavailable, not denied', async () => {
  const { router, run } = fixture({ availability: () => downloadable }, { builtin: local });
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ code: 'unavailable' });
});

test('all unavailable answers give unavailable', async () => {
  const { router, run } = fixture({ availability: () => ({ status: 'unavailable' }) });
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ code: 'unavailable' });
});

test.each([true, false])(
  'per-call feature requirements filter providers: supported %s',
  async (supported) => {
    const availability = vi.fn(() => ({ status: 'available' as const }));
    const { router, run } = fixture(
      { availability },
      {
        plain: local,
        ...(supported
          ? { structured: { ...local, features: ['structured-output'] as const } }
          : {}),
      },
    );
    const waiting = router.port(run).begin('assistant', { requires: ['structured-output'] });
    if (supported) expect(await waiting).toMatchObject({ providerId: 'structured' });
    else await expect(waiting).rejects.toMatchObject({ code: 'unavailable' });
    expect(availability).toHaveBeenCalledTimes(supported ? 1 : 0);
  },
);

test.each([['teleport'], 'streaming', [1]])(
  'invalid feature requirement %j rejects before probing',
  async (requires) => {
    const availability = vi.fn(() => ({ status: 'available' as const }));
    const { router, run } = fixture({ availability });
    await expect(
      router.port(run).begin('assistant', { requires: requires as never }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(availability).not.toHaveBeenCalled();
  },
);

test.each(['availability', 'download'] as const)(
  'run cancellation during %s reserves nothing',
  async (hook) => {
    const answer = deferred<never>();
    const { router, run, controller } = fixture(
      {
        availability: hook === 'availability' ? () => answer.promise : () => downloadable,
        download: () => answer.promise,
      },
      { builtin: local },
    );
    const waiting = router.port(run).begin('assistant');
    await flush();
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' });
    expect(run.selectedRouteChanged).not.toHaveBeenCalled();
    expect(() => run.budget.reserveModel(1000, 0)).not.toThrow();
  },
);

test('labels are rechecked after a probe before any download or credential', async () => {
  const answer = deferred<ModelAvailability>();
  const consent = vi.fn(() => true);
  const { router, run } = fixture({ availability: () => answer.promise, consent }, { remote });
  const waiting = router.port(run).begin('assistant');
  await flush();
  run.labels.add('private-user');
  answer.resolve({ status: 'available' });
  await expect(waiting).rejects.toMatchObject({ code: 'denied' });
  expect(consent).not.toHaveBeenCalled();
});

test('duplicate provider IDs are probed once per walk', async () => {
  const availability = vi.fn(() => ({ status: 'unavailable' as const }));
  const { router, run } = fixture(
    {
      availability,
      roles: {
        assistant: { providers: ['builtin', 'builtin'], allow: ['in-browser'], maxTokens: 1000 },
      },
    },
    { builtin: local },
  );
  await expect(router.port(run).begin('assistant')).rejects.toMatchObject({ code: 'unavailable' });
  expect(availability).toHaveBeenCalledTimes(1);
});

test.each(['availability', 'download'] as const)('construction validates the %s hook', (hook) => {
  expect(() => fixture({ [hook]: 1 } as never)).toThrow(
    expect.objectContaining({ code: 'invalid' }),
  );
});
