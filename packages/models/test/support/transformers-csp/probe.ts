// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import workerUrl from './probe.worker.ts?worker&url';
import type { PageData, WorkerReport } from './report.js';

const data: PageData = {
  done: false,
  pageViolations: [],
  trustedTypesPolicyCreated: false,
  workerUrlsChecked: 0,
};
Reflect.set(globalThis, 'onnxProbe', data);
document.addEventListener('securitypolicyviolation', (event) => {
  data.pageViolations.push(`${event.violatedDirective}|${event.blockedURI}|${event.sample}`);
});

interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
}

const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypesFactory })
  .trustedTypes;
if (factory) {
  factory.createPolicy('default', {
    createScriptURL: (value) => {
      const candidate = new URL(value, location.href);
      if (candidate.href !== new URL(workerUrl, location.href).href)
        throw new TypeError('The worker script URL is not allowed.');
      data.workerUrlsChecked += 1;
      return candidate.href;
    },
  });
  data.trustedTypesPolicyCreated = true;
}

try {
  const worker = new Worker(workerUrl, { type: 'module' });
  worker.addEventListener('message', (event: MessageEvent<WorkerReport>) => {
    data.report = event.data;
    data.done = true;
    worker.terminate();
  });
  worker.addEventListener('error', (event) => {
    data.workerError = event.message || 'The worker raised an error event.';
    data.done = true;
  });
} catch (error) {
  data.workerError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  data.done = true;
}
