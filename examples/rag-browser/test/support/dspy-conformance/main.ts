// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie/adapter-pyodide';
import {
  type DspyTranscript,
  dspyCases,
  executeDspyCase,
} from '../../../../../tests/conformance/support/dspy.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: { transcript?: DspyTranscript; error?: string; violations: string[]; done: boolean } =
  { violations: [], done: false };
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
  if (!dspyCases.includes(name)) throw new Error('The conformance case is unknown.');
  result.transcript = await executeDspyCase(
    {
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
    },
    {
      baseUrl: new URL(`/conformance/${name}/`, location.href).href,
      files: ['suite.py', 'selected.py'],
      module: 'selected',
      entry: 'create_agent',
    },
    name,
    new URLSearchParams(location.search).has('steps')
      ? Number(new URLSearchParams(location.search).get('steps'))
      : undefined,
  );
} catch (error) {
  result.error = String(error);
} finally {
  result.done = true;
}
