// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie-ai/adapter-pyodide';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import {
  type DspyTranscript,
  dspyBranchReloadCases,
  dspyCases,
  executeDspyCase,
} from '../../../../../tests/conformance/support/dspy.js';
import {
  executeDspyParallelStep,
  type ParallelResult,
} from '../../../../../tests/conformance/support/dspy-parallel-step.js';
import {
  type DspyReloadResult,
  type DspyReloadStep,
  dspyRejectedRestoreCases,
  dspyReloadCases,
  executeDspyReloadStep,
} from '../../../../../tests/conformance/support/dspy-restore.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: {
  transcript?: DspyTranscript;
  reload?: DspyReloadResult;
  branches?: ParallelResult;
  error?: string;
  errorCode?: string;
  exported?: unknown;
  personal?: unknown;
  violations: string[];
  done: boolean;
} = { violations: [], done: false };
Reflect.set(globalThis, 'dspyConformance', result);
addEventListener('securitypolicyviolation', (event) =>
  result.violations.push(event.effectiveDirective),
);
const url = new URL(workerUrl, location.href).href;
const factory = Reflect.get(globalThis, 'trustedTypes') as {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
};
factory.createPolicy('default', {
  createScriptURL(value) {
    if (new URL(value, location.href).href !== url) throw new TypeError('Unexpected Worker URL.');
    return url;
  },
});
try {
  const name = new URLSearchParams(location.search).get('case') ?? '';
  const parameters = new URLSearchParams(location.search);
  if (
    ![
      ...dspyCases,
      ...dspyReloadCases,
      ...dspyRejectedRestoreCases,
      ...dspyBranchReloadCases,
    ].includes(name)
  )
    throw new Error('The conformance case is unknown.');
  const options: PyodideAdapterOptions = {
    runtimeUrl: new URL('/python/runtime/', location.href).href,
    wheelsUrl: new URL('/python/wheels/', location.href).href,
    localWheels: PYTHON_LOCAL_WHEELS,
    createWorker() {
      const worker = new Worker(url, { type: 'module' });
      worker.addEventListener('message', (event) => {
        const value = JSON.parse(event.data as string) as { type?: string; directive?: string };
        if (value.type === 'violation') result.violations.push(value.directive ?? 'unknown');
      });
      return worker;
    },
  };
  const agent = {
    baseUrl: new URL(`/conformance/${name}/`, location.href).href,
    files: [parameters.has('reload') ? 'durable.py' : 'suite.py', 'selected.py'],
    module: 'selected',
    entry: 'create_agent',
  };
  if ((dspyBranchReloadCases as readonly string[]).includes(name)) {
    agent.files = ['parallel_programs.py', 'parallel_candidate.py', 'selected.py'];
    const saved = sessionStorage.getItem('dspyBranchStep');
    const step = saved ? JSON.parse(saved) : { name: 'par-fan-two-stage-single' };
    if (step.name !== 'par-fan-two-stage-single')
      throw new Error('The branch reload case does not match.');
    const saver = await IndexedDBSaver.open({
      databaseName: 'dspy-branches',
      appId: 'dspy-parallel-spike',
      principalScope: 'fixture',
    });
    try {
      result.branches = await executeDspyParallelStep(
        options,
        agent,
        { recovery: saver.recovery, checkpoints: saver.byteRecords },
        step,
      );
    } finally {
      saver.close();
    }
  } else if (parameters.has('reload')) {
    const saved = sessionStorage.getItem('dspyReloadStep');
    const step: DspyReloadStep & { fault?: string } = saved
      ? JSON.parse(saved)
      : { name, accepted: parameters.has('accepted') };
    if (step.name !== name) throw new Error('The reload case does not match its page.');
    const saver = await IndexedDBSaver.open({
      databaseName: 'dspy-reload',
      appId: 'dspy-restore',
      principalScope: 'fixture',
    });
    try {
      let completionFailed = false;
      const recovery = new Proxy(saver.recovery, {
        get(target, key) {
          if (key === 'recordEffect' && step.fault === 'unfinished')
            return async (...args: Parameters<typeof target.recordEffect>) => {
              if (args[2].status !== 'succeeded') await target.recordEffect(...args);
            };
          if (key === 'session' && step.fault === 'executor')
            return async (session: string) => {
              const saved = await target.session(session);
              return saved ? { ...saved, executorId: 'pydantic-ai-python' } : saved;
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      if (step.fault === 'changed')
        agent.baseUrl = new URL(`/conformance/${name}-changed/`, location.href).href;
      if (step.fault === 'orphan' && step.sessionId) {
        const saved = (await saver.byteRecords.request({
          op: 'get',
          executor: 'dspy-python',
          sessionId: step.sessionId,
          namespace: '',
        })) as { id: string };
        await saver.byteRecords.request({
          op: 'put-writes',
          executor: 'dspy-python',
          sessionId: step.sessionId,
          namespace: '',
          id: (BigInt(saved.id) + 1n).toString().padStart(20, '0'),
          taskId: 'conversation',
          taskPath: '',
          writes: [
            {
              channel: '__interrupt__',
              index: -3,
              interruptIds: ['orphan'],
              value: { type: 'json', bytes: new TextEncoder().encode('{"id":"orphan"}') },
            },
          ],
        });
      }
      result.reload = await executeDspyReloadStep(
        options,
        agent,
        {
          recovery,
          checkpoints: {
            async request(value: unknown): Promise<unknown> {
              const input = value as { op: string; parentId?: string | null };
              if (
                step.fault === 'completion' &&
                input.op === 'put' &&
                input.parentId != null &&
                !completionFailed
              ) {
                completionFailed = true;
                throw new Error('Private host storage failure.');
              }
              if (input.op === 'put' && ['logout', 'takeover'].includes(step.fault ?? '')) {
                if (step.fault === 'logout') await saver.invalidatePrincipal();
                else {
                  const other = await IndexedDBSaver.open({
                    databaseName: 'dspy-reload',
                    appId: 'dspy-restore',
                    principalScope: 'other',
                  });
                  try {
                    await other.fencing.claim();
                  } finally {
                    other.close();
                  }
                }
              }
              const reply = await saver.byteRecords.request(value);
              if (
                input.op === 'get' &&
                reply &&
                ['version', 'format', 'session', 'corrupt'].includes(step.fault ?? '')
              ) {
                const tuple = reply as {
                  metadata: { bytes: Uint8Array };
                  checkpoint: { bytes: Uint8Array };
                };
                const meta = JSON.parse(new TextDecoder().decode(tuple.metadata.bytes));
                if (step.fault === 'version') meta.dspy = '0.0.0';
                if (step.fault === 'format') meta.v = 2;
                if (step.fault === 'session') meta.session = 'other';
                tuple.metadata.bytes = new TextEncoder().encode(JSON.stringify(meta));
                if (step.fault === 'corrupt')
                  tuple.checkpoint.bytes = new TextEncoder().encode('corrupt');
              }
              return reply;
            },
          },
        },
        step,
      );
      result.exported = await saver.exportSession(result.reload.sessionId);
      result.personal = await saver.exportSession(result.reload.sessionId, {
        personalContent: true,
      });
    } finally {
      saver.close();
    }
  } else
    result.transcript = await executeDspyCase(
      options,
      agent,
      name,
      new URLSearchParams(location.search).has('steps')
        ? Number(new URLSearchParams(location.search).get('steps'))
        : undefined,
    );
} catch (error) {
  result.error = error instanceof Error ? error.message : 'The DSPy conformance case failed.';
  if (typeof error === 'object' && error !== null && 'code' in error)
    result.errorCode = String(error.code);
} finally {
  result.done = true;
}
