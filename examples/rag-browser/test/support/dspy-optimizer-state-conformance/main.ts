// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie-ai/adapter-pyodide';
import type { DspyTranscript } from '../../../../../tests/conformance/support/dspy.js';
import {
  dspyOptimizerStateCases,
  executeDspyOptimizerStateCase,
} from '../../../../../tests/conformance/support/dspy-optimizer-state.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: { transcript?: DspyTranscript; error?: string; violations: string[]; done: boolean } =
  {
    violations: [],
    done: false,
  };
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
  if (!dspyOptimizerStateCases.includes(name))
    throw new Error('The optimizer state case is unknown.');
  result.transcript = await executeDspyOptimizerStateCase(
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
      files: ['optimizer_state_suite.py', 'state.json', 'selected.py'],
      module: 'selected',
      entry: 'create_agent',
    },
    name,
  );
} catch (error) {
  result.error = error instanceof Error ? error.message : 'The optimizer state case failed.';
} finally {
  result.done = true;
}
