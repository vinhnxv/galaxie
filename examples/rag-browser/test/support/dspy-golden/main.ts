// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie-ai/adapter-pyodide';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import {
  type DspyTranscript,
  executeDspyCase,
} from '../../../../../tests/conformance/support/dspy.js';
import {
  dspyGoldenCases,
  executeDspyGolden,
  type GoldenResult,
  type GoldenStep,
} from '../../../../../tests/conformance/support/dspy-golden.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: {
  done: boolean;
  error?: string;
  errorCode?: string;
  violations: string[];
  workerErrors: string[];
  traffic: { kind: string; op: string; replayed: boolean }[];
  transcript?: DspyTranscript;
  golden?: GoldenResult;
} = { done: false, violations: [], workerErrors: [], traffic: [] };
Reflect.set(globalThis, 'dspyGoldenConformance', result);
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
  if (name !== 'predict' && !dspyGoldenCases.includes(name))
    throw new Error('The DSPy golden page case is unknown.');
  const options: PyodideAdapterOptions = {
    runtimeUrl: new URL('/python/runtime/', location.href).href,
    wheelsUrl: new URL('/python/wheels/', location.href).href,
    localWheels: PYTHON_LOCAL_WHEELS,
    createWorker() {
      const worker = new Worker(url, { type: 'module' });
      worker.addEventListener('error', (event) => result.workerErrors.push(event.message));
      worker.addEventListener('message', (event) => {
        const value = JSON.parse(event.data as string) as {
          type?: string;
          directive?: string;
          kind?: string;
          op?: string;
          payload?: unknown[];
        };
        if (value.type === 'violation') result.violations.push(value.directive ?? 'unknown');
        if (value.kind && value.op) {
          const replayed =
            value.kind === 'notify' &&
            value.op === 'stream' &&
            (value.payload?.[2] as { kind?: string })?.kind === 'replayed';
          if (replayed || (value.kind === 'request' && ['model', 'capability'].includes(value.op)))
            result.traffic.push({ kind: value.kind, op: value.op, replayed });
        }
      });
      return worker;
    },
  };
  const agent = {
    baseUrl: new URL(`/conformance/${name}/`, location.href).href,
    files:
      name === 'predict'
        ? ['suite.py', 'selected.py']
        : name.startsWith('rt-')
          ? ['runtime_programs.py', 'selected.py']
          : name.startsWith('pe-')
            ? ['provider_programs.py', 'selected.py']
            : ['selected.py'],
    module: 'selected',
    entry: 'create_agent',
  };
  if (name === 'predict') result.transcript = await executeDspyCase(options, agent, name);
  else if (parameters.has('reload')) {
    if (name !== 'rt-opt-labeled-two-stage')
      throw new Error('The DSPy golden reload case is unknown.');
    const saved = sessionStorage.getItem('dspyGoldenStep');
    const step: GoldenStep = saved ? JSON.parse(saved) : {};
    const saver = await IndexedDBSaver.open({
      databaseName: 'dspy-golden-reload',
      appId: 'dspy-golden',
      principalScope: 'fixture',
    });
    try {
      result.golden = await executeDspyGolden(
        options,
        agent,
        name,
        { recovery: saver.recovery, checkpoints: saver.byteRecords },
        step,
      );
    } finally {
      saver.close();
    }
  } else result.golden = await executeDspyGolden(options, agent, name);
} catch (error) {
  result.error = error instanceof Error ? error.message : 'The DSPy golden measurement failed.';
  if (typeof error === 'object' && error !== null && 'code' in error)
    result.errorCode = String(error.code);
} finally {
  result.done = true;
}
