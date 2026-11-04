// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Hosts configure zod before anything validates: its JIT probe is a Trusted Types sink.
import '../../../src/host/zod-config.js';
import type { GoWorkerPort } from '../../../../../packages/adapter-go/src/index.js';
import { type Observed, runCase, type Script } from './run.ts';
import workerUrl from './worker.ts?worker&url';

declare const REFERENCE_WASM: { url: string; sha256: string; bytes: number };
declare const REFERENCE_SCRIPTS: Record<string, Script>;

interface PageState {
  results: Record<string, Observed>;
  errors: Record<string, string>;
  violations: string[];
  done: boolean;
}
const state: PageState = { results: {}, errors: {}, violations: [], done: false };
Reflect.set(globalThis, 'adkGo', state);
addEventListener('securitypolicyviolation', (event) =>
  state.violations.push(
    `${event.effectiveDirective} ${event.sourceFile}:${event.lineNumber} ${event.sample}`,
  ),
);

// Only the adapter's own Worker may be constructed; anything else is refused.
const allowed = new URL(workerUrl, location.href).href;
const factory = Reflect.get(globalThis, 'trustedTypes') as {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
};
factory.createPolicy('default', {
  createScriptURL(value) {
    const href = new URL(value, location.href).href;
    if (href !== allowed) throw new TypeError('Unexpected Worker URL.');
    return href;
  },
});

const wasm = { ...REFERENCE_WASM, url: new URL(REFERENCE_WASM.url, location.href).href };
for (const [name, script] of Object.entries(REFERENCE_SCRIPTS)) {
  try {
    state.results[name] = await runCase(
      name,
      script,
      wasm,
      () => new Worker(allowed, { type: 'module' }) as unknown as GoWorkerPort,
    );
  } catch (error) {
    state.errors[name] = String(error);
  }
}
state.done = true;
