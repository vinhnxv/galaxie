// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

/// <reference types="vite/client" />

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie/adapter-pyodide';
import {
  executePydanticCase,
  type PydanticTranscript,
  pydanticCases,
} from '../../../../../tests/conformance/support/pydantic-ai.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: {
  transcript?: PydanticTranscript;
  error?: string;
  violations: string[];
  done: boolean;
} = { violations: [], done: false };
Object.assign(globalThis, { pydanticConformance: result });
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
    if (!(pydanticCases as readonly string[]).includes(name))
      throw new Error('The conformance case is unknown.');
    result.transcript = await executePydanticCase(
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
        files: ['suite.py', 'selected.py'],
      },
      name,
    );
  } catch (error) {
    result.error = error instanceof Error ? error.message : 'pydantic-ai conformance failed.';
  } finally {
    result.done = true;
  }
})();
