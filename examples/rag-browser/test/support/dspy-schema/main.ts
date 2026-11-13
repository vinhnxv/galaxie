// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import '../../../src/host/zod-config.js';
import type { PyodideAdapterOptions } from '@galaxie-ai/adapter-pyodide';
import {
  dspySchemaCases,
  executeDspySchema,
  type SchemaResult,
} from '../../../../../tests/conformance/support/dspy-schema.js';
import workerUrl from '../python-parity/pyodide-worker.ts?worker&url';

declare const PYTHON_LOCAL_WHEELS: PyodideAdapterOptions['localWheels'];
const result: {
  done: boolean;
  error?: string;
  errorCode?: string;
  violations: string[];
  workerErrors: string[];
  schema?: SchemaResult;
} = { done: false, violations: [], workerErrors: [] };
Reflect.set(globalThis, 'dspySchemaConformance', result);
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
  if (!dspySchemaCases.includes(name)) throw new Error('The DSPy schema page case is unknown.');
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
  result.schema = await executeDspySchema(
    options,
    {
      baseUrl: new URL(`/conformance/${name}/`, location.href).href,
      files: ['schema_programs.py', 'selected.py'],
      module: 'selected',
      entry: 'create_agent',
    },
    name,
    { feature: !parameters.has('no-feature') },
  );
} catch (error) {
  result.error = error instanceof Error ? error.message : 'The DSPy schema measurement failed.';
  if (typeof error === 'object' && error !== null && 'code' in error)
    result.errorCode = String(error.code);
} finally {
  result.done = true;
}
