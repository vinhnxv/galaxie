// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/// <reference types="vite/client" />

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie-ai/adapter-pyodide';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import {
  type AdkPythonTranscript,
  adkPythonCases,
  executeAdkPythonCase,
} from '../../../../../tests/conformance/support/adk-python.js';
import {
  type AdkReloadResult,
  type AdkReloadStep,
  adkPythonReloadCases,
  adkPythonWriteCases,
  executeAdkReloadStep,
} from '../../../../../tests/conformance/support/adk-python-restore.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: {
  transcript?: AdkPythonTranscript;
  reload?: AdkReloadResult;
  error?: string;
  violations: string[];
  done: boolean;
} = { violations: [], done: false };
Object.assign(globalThis, { adkPythonConformance: result });
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
void (async () => {
  try {
    const parameters = new URLSearchParams(location.search);
    const name = parameters.get('case') ?? '';
    const reload = parameters.has('reload');
    const known = reload
      ? [...adkPythonReloadCases, ...adkPythonWriteCases]
      : (adkPythonCases as readonly string[]);
    if (!(known as readonly string[]).includes(name))
      throw new Error('The conformance case is unknown.');
    const options: PyodideAdapterOptions = {
      runtimeUrl: new URL('/python/runtime/', location.href).href,
      wheelsUrl: new URL('/python/wheels/', location.href).href,
      localWheels: PYTHON_LOCAL_WHEELS,
      createWorker() {
        const worker = new Worker(url, { type: 'module' });
        worker.addEventListener('message', (event) => {
          const message = JSON.parse(event.data as string) as {
            type?: string;
            directive?: string;
          };
          if (message.type === 'violation') result.violations.push(message.directive ?? 'unknown');
        });
        return worker;
      },
    };
    const agent = {
      baseUrl: new URL(`/conformance/${name}/`, location.href).href,
      module: 'selected',
      entry: 'create_agent',
      files: ['suite.py', 'selected.py'],
    };
    if (reload) {
      const saved = sessionStorage.getItem('adkReloadStep');
      const step: AdkReloadStep = saved
        ? JSON.parse(saved)
        : { name, ...(parameters.has('accepted') ? { accepted: true } : {}) };
      if (step.name !== name) throw new Error('The reload fixture does not match its page.');
      const saver = await IndexedDBSaver.open({
        databaseName: 'adk-python-conformance-reload',
        appId: 'adk-python-restore',
        principalScope: 'fixture',
      });
      try {
        result.reload = await executeAdkReloadStep(
          options,
          agent,
          { checkpoints: saver.byteRecords, recovery: saver.recovery },
          step,
        );
      } finally {
        saver.close();
      }
    } else result.transcript = await executeAdkPythonCase(options, agent, name);
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'The conformance case failed.';
  } finally {
    result.done = true;
  }
})();
