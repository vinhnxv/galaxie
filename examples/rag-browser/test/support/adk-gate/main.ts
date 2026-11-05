// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import workerUrl from './worker.ts?worker&url';

const state: { result?: unknown; error?: string; violations: string[]; networkAttempts?: number } =
  {
    violations: [],
  };
Reflect.set(globalThis, 'adkGate', state);
addEventListener('securitypolicyviolation', (event) =>
  state.violations.push(event.effectiveDirective),
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
const worker = new Worker(url, { type: 'module' });
worker.onmessage = (event: MessageEvent<typeof state>) => {
  const { violations, ...rest } = event.data;
  Object.assign(state, rest);
  state.violations.push(...violations);
};
worker.onerror = () => {
  state.error = 'Worker failed.';
};
