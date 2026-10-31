// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import workerUrl from './worker.ts?worker&url';

const state: { result?: unknown; error?: string; violations: string[] } = { violations: [] };
Reflect.set(globalThis, 'dspyGate', state);
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
worker.onmessage = (event: MessageEvent<typeof state>) => Object.assign(state, event.data);
worker.onerror = () => {
  state.error = 'Worker failed.';
};
