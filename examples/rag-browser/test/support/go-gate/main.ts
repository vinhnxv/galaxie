// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createGoAdapter } from '../../../../../packages/adapter-go/src/adapter.js';
import adapterWorkerUrl from './adapter-worker.ts?worker&url';
import gateWorkerUrl from './gate-worker.ts?worker&url';

declare const GO_GATE_WASM: { url: string; sha256: string; bytes: number };

interface PageState {
  report?: unknown;
  adapter?: { coldStartMs: number; wallMs: number; disposed: boolean };
  adapterError?: string;
  error?: string;
  violations: string[];
}
const state: PageState = { violations: [] };
Reflect.set(globalThis, 'goGate', state);
addEventListener('securitypolicyviolation', (event) =>
  state.violations.push(event.effectiveDirective),
);
const allowed = [gateWorkerUrl, adapterWorkerUrl].map((url) => new URL(url, location.href).href);
const factory = Reflect.get(globalThis, 'trustedTypes') as {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
};
factory.createPolicy('default', {
  createScriptURL(value) {
    const href = new URL(value, location.href).href;
    if (!allowed.includes(href)) throw new TypeError('Unexpected Worker URL.');
    return href;
  },
});
const wasm = { ...GO_GATE_WASM, url: new URL(GO_GATE_WASM.url, location.href).href };

// The shipped adapter boots its Worker and reports ready.
try {
  const wallStart = performance.now();
  const adapter = createGoAdapter({
    createWorker: () =>
      new Worker(allowed[1] as string, { type: 'module' }) as unknown as ReturnType<
        Parameters<typeof createGoAdapter>[0]['createWorker']
      >,
    onBoot: (event) => {
      if (event.phase === 'ready')
        state.adapter = {
          coldStartMs: event.coldStartMs ?? -1,
          wallMs: Math.round(performance.now() - wallStart),
          disposed: false,
        };
    },
  });
  const prepared = await adapter.prepare({ wasm }, undefined, {
    signal: new AbortController().signal,
  } as never);
  await prepared.dispose();
  if (state.adapter) state.adapter.disposed = true;
} catch (error) {
  state.adapterError = String(error);
}
// The scenarios run in a second Worker through the same loader.
try {
  const worker = new Worker(allowed[0] as string, { type: 'module' });
  state.report = await new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
    worker.onerror = () => reject(new Error('Worker failed.'));
    worker.postMessage(wasm);
  });
} catch (error) {
  state.error = String(error);
}
