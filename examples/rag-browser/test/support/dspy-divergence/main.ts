// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie-ai/adapter-pyodide';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import { executePoisonRetry } from '../../../../../tests/conformance/support/dspy-poison-retry.js';
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
  commands: string[];
  reload?: DspyReloadResult;
  retry?: Awaited<ReturnType<typeof executePoisonRetry>>;
  bindTraffic?: { models: number; capabilities: number; replayed: number };
} = { done: false, violations: [], workerErrors: [], commands: [] };
Reflect.set(globalThis, 'dspyDivergenceConformance', result);
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
  const variant = new URLSearchParams(location.search).get('variant') ?? 'changed';
  if (variant !== 'changed' && variant !== 'removed' && variant !== 'same-instance')
    throw new Error('Unknown divergence variant.');
  const saved = sessionStorage.getItem('dspyDivergenceStep');
  const step: DspyReloadStep & { program: string; variant: string } = saved
    ? JSON.parse(saved)
    : {
        name: 'poison-original',
        program: variant === 'same-instance' ? 'same-instance' : 'original',
        variant,
      };
  const observed = observeStateBind({
    runtimeUrl: new URL('/python/runtime/', location.href).href,
    wheelsUrl: new URL('/python/wheels/', location.href).href,
    localWheels: PYTHON_LOCAL_WHEELS,
    createWorker() {
      const worker = new Worker(url, { type: 'module' });
      const send = worker.postMessage.bind(worker);
      worker.postMessage = (raw: string): void => {
        const message = JSON.parse(raw) as { kind: string; op: string };
        if (message.kind === 'request') result.commands.push(message.op);
        send(raw);
      };
      worker.addEventListener('error', (event) => result.workerErrors.push(event.message));
      worker.addEventListener('message', (event) => {
        const message = JSON.parse(event.data as string) as { type?: string; directive?: string };
        if (message.type === 'violation') result.violations.push(message.directive ?? 'unknown');
      });
      return worker;
    },
  });
  result.bindTraffic = observed.traffic;
  const saver = await IndexedDBSaver.open({
    databaseName: `dspy-divergence-${step.variant}`,
    appId: 'dspy-restore',
    principalScope: 'fixture',
  });
  try {
    const agent = {
      baseUrl: new URL(`/conformance/poison-${step.program}/`, location.href).href,
      files: ['binding_poison_programs.py', 'selected.py'],
      module: 'selected',
      entry: 'create_agent',
    };
    const store = { recovery: saver.recovery, checkpoints: saver.byteRecords };
    if (variant === 'same-instance')
      result.retry = await executePoisonRetry(observed.options, agent, store, async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(`dspy-divergence-${variant}`);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          const stores = ['checkpoints', 'writes', 'journal'];
          const tx = db.transaction(stores, 'readonly');
          const rows = await Promise.all(
            stores.map(
              (name) =>
                new Promise<unknown>((resolve, reject) => {
                  const request = tx.objectStore(name).getAll();
                  request.onsuccess = () => resolve(request.result);
                  request.onerror = () => reject(request.error);
                }),
            ),
          );
          return JSON.stringify(rows, (_key, value: unknown) =>
            value instanceof Uint8Array ? [...value] : value,
          );
        } finally {
          db.close();
        }
      });
    else result.reload = await executeDspyReloadStep(observed.options, agent, store, step);
  } finally {
    saver.close();
  }
} catch (error) {
  result.error = error instanceof Error ? error.message : 'The DSPy divergence measurement failed.';
  if (typeof error === 'object' && error !== null && 'code' in error)
    result.errorCode = String(error.code);
} finally {
  result.done = true;
}
