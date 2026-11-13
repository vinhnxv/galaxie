// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie-ai/adapter-pyodide';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import fixtures from '../../../../../tests/conformance/cases-dspy/engine-fixtures.json' with {
  type: 'json',
};
import {
  executeDspyParallelStep,
  type ParallelResult,
} from '../../../../../tests/conformance/support/dspy-parallel-step.js';
import {
  type DspyReloadResult,
  type DspyReloadStep,
  executeDspyReloadStep,
} from '../../../../../tests/conformance/support/dspy-restore.js';
import { observeStateBind } from '../../../../../tests/conformance/support/dspy-state-bind.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: {
  done: boolean;
  error?: string;
  errorCode?: string;
  violations: string[];
  workerErrors: string[];
  reload?: DspyReloadResult;
  parallel?: ParallelResult;
  bindTraffic?: { models: number; capabilities: number; replayed: number };
} = { done: false, violations: [], workerErrors: [] };
Reflect.set(globalThis, 'dspyEngineConformance', result);
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
  const parameters = new URLSearchParams(location.search);
  const name = parameters.get('case') ?? '';
  const options: PyodideAdapterOptions = {
    runtimeUrl: new URL('/python/runtime/', location.href).href,
    wheelsUrl: new URL('/python/wheels/', location.href).href,
    localWheels: PYTHON_LOCAL_WHEELS,
    createWorker() {
      const worker = new Worker(url, { type: 'module' });
      worker.addEventListener('error', (event) => result.workerErrors.push(event.message));
      worker.addEventListener('message', (event) => {
        const value = JSON.parse(event.data as string) as { type?: string; directive?: string };
        if (value.type === 'violation') result.violations.push(value.directive ?? 'unknown');
      });
      return worker;
    },
  };
  if (parameters.get('mode') === 'repause') {
    if (name !== 'bind-legacy-repause') throw new Error('The re-pause case is unknown.');
    const saved = sessionStorage.getItem('dspyEngineStep');
    const step: DspyReloadStep & { changed?: boolean } = saved
      ? JSON.parse(saved)
      : { name: 'durable-two' };
    const observed = observeStateBind(options);
    result.bindTraffic = observed.traffic;
    const saver = await IndexedDBSaver.open({
      databaseName: 'dspy-engine-repause',
      appId: 'dspy-restore',
      principalScope: 'fixture',
    });
    try {
      result.reload = await executeDspyReloadStep(
        observed.options,
        {
          baseUrl: new URL(`/conformance/${name}${step.changed ? '-changed' : ''}/`, location.href)
            .href,
          files: ['durable.py', 'unrelated.json', 'selected.py'],
          module: 'selected',
          entry: 'create_agent',
        },
        { recovery: saver.recovery, checkpoints: saver.byteRecords },
        step,
      );
    } finally {
      saver.close();
    }
  } else {
    if (!fixtures.threadPool.includes(name)) throw new Error('The thread-pool case is unknown.');
    const saver = await IndexedDBSaver.open({
      databaseName: `dspy-engine-${name}`,
      appId: 'dspy-parallel-spike',
      principalScope: 'fixture',
    });
    try {
      result.parallel = await executeDspyParallelStep(
        options,
        {
          baseUrl: new URL(`/conformance/${name}/`, location.href).href,
          files: ['parallel_programs.py', 'selected.py'],
          module: 'selected',
          entry: 'create_agent',
        },
        { recovery: saver.recovery, checkpoints: saver.byteRecords },
        { name },
      );
    } finally {
      saver.close();
    }
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : 'The DSPy engine measurement failed.';
  if (typeof error === 'object' && error !== null && 'code' in error)
    result.errorCode = String(error.code);
} finally {
  result.done = true;
}
