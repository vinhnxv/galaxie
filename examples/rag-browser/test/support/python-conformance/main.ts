// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="vite/client" />

import type { PyodideAdapterOptions } from '@galaxie/adapter-pyodide';
import {
  executePythonCase,
  type PythonCaseTranscript,
  pythonStageACases,
} from '../../../../../tests/conformance/support/python-stage-a.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: {
  transcript?: PythonCaseTranscript;
  error?: string;
  violations: string[];
  done: boolean;
} = { violations: [], done: false };
Object.assign(globalThis, { pythonConformance: result });
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
    const name = new URLSearchParams(location.search).get('case') ?? '';
    if (!(pythonStageACases as readonly string[]).includes(name))
      throw new Error('The conformance case is unknown.');
    const module = name.replaceAll('-', '_');
    const files = [...new Set(['fixture_support', 'interrupt_resume', module])].map(
      (file) => `${file}.py`,
    );
    files.push('selected.py');
    result.transcript = await executePythonCase(
      {
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
            if (message.type === 'violation')
              result.violations.push(message.directive ?? 'unknown');
          });
          return worker;
        },
      },
      {
        baseUrl: new URL(`/conformance/${name}/`, location.href).href,
        module: 'selected',
        entry: 'create_agent',
        files,
      },
      name,
      { value: 1 },
      name === 'interrupt-sequence'
        ? [
            { action: 'submit', payload: 'first' },
            { action: 'submit', payload: false },
          ]
        : [{ action: 'submit', payload: { answer: 'yes' } }],
    );
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'Python conformance failed.';
  } finally {
    result.done = true;
  }
})();
