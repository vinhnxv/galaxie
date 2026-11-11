// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie-ai/adapter-pyodide';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import type { DspyTranscript } from '../../../../../tests/conformance/support/dspy.js';
import {
  type DspyReloadResult,
  type DspyReloadStep,
  executeDspyReloadStep,
} from '../../../../../tests/conformance/support/dspy-restore.js';
import {
  dspyStateCases,
  executeDspyStateCase,
} from '../../../../../tests/conformance/support/dspy-state.js';
import {
  observeStateBind,
  stateBindScenarios,
} from '../../../../../tests/conformance/support/dspy-state-bind.js';
import {
  stateLimitCases,
  stateLimitSpec,
} from '../../../../../tests/conformance/support/dspy-state-limits.js';
import { stateRestoreScenarios } from '../../../../../tests/conformance/support/dspy-state-restore.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: {
  transcript?: DspyTranscript;
  reload?: DspyReloadResult;
  error?: string;
  errorCode?: string;
  violations: string[];
  done: boolean;
  bindTraffic?: { models: number; capabilities: number; replayed: number };
} = { violations: [], done: false };
Reflect.set(globalThis, 'dspyStateConformance', result);
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
  const bindScenario = stateBindScenarios.find((scenario) => scenario.name === name);
  const scenario = bindScenario ?? stateRestoreScenarios.find((scenario) => scenario.name === name);
  if (
    !scenario &&
    ![...dspyStateCases, ...Object.keys(stateLimitCases), 'state-pickle-source'].includes(name)
  )
    throw new Error('The state conformance case is unknown.');
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
  const observed = observeStateBind(options);
  if (bindScenario) result.bindTraffic = observed.traffic;
  if (parameters.has('reload')) {
    if (!scenario) throw new Error('The state restore scenario is unknown.');
    const saved = sessionStorage.getItem('dspyStateReloadStep');
    const step: DspyReloadStep & { variant?: 'resume' } = saved
      ? JSON.parse(saved)
      : { name: scenario.program };
    if (step.name !== scenario.program)
      throw new Error('The reload program does not match its page.');
    const saver = await IndexedDBSaver.open({
      databaseName: 'dspy-state-reload',
      appId: 'dspy-restore',
      principalScope: 'fixture',
    });
    try {
      result.reload = await executeDspyReloadStep(
        bindScenario ? observed.options : options,
        {
          baseUrl: new URL(
            `/conformance/${name}${step.variant === 'resume' ? '-resume' : ''}/`,
            location.href,
          ).href,
          files: ['state_durable.py', 'state.json', 'selected.py'],
          module: 'selected',
          entry: 'create_agent',
        },
        { recovery: saver.recovery, checkpoints: saver.byteRecords },
        step,
      );
    } finally {
      saver.close();
    }
  } else
    result.transcript = await executeDspyStateCase(
      options,
      {
        baseUrl: new URL(`/conformance/${name}/`, location.href).href,
        files: [
          'state_suite.py',
          'state.json',
          'selected.py',
          ...(name === 'state-pickle-source' ? ['state.pkl'] : []),
        ],
        module: 'selected',
        entry: 'create_agent',
      },
      name,
      dspyStateCases.includes(name) ? undefined : stateLimitSpec,
    );
} catch (error) {
  result.error = error instanceof Error ? error.message : 'The DSPy state conformance case failed.';
  if (typeof error === 'object' && error !== null && 'code' in error)
    result.errorCode = String(error.code);
} finally {
  result.done = true;
}
