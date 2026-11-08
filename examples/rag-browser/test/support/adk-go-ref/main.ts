// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Hosts configure zod before anything validates: its JIT probe is a Trusted Types sink.
import '../../../src/host/zod-config.js';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import type { GoWorkerPort } from '../../../../../packages/adapter-go/src/index.js';
import workerUrl from '../go-gate/adapter-worker.ts?worker&url';
import { type Durability, type Observed, runCase, type Script } from './run.js';

declare const REFERENCE_WASM: { url: string; sha256: string; bytes: number };
declare const REFERENCE_SCRIPTS: Record<string, Script>;

interface PageState {
  results: Record<string, Observed>;
  /** Pausing cases run again with a reload and a new Worker at every pause, over IndexedDB. */
  durable: Record<string, Observed>;
  errors: Record<string, string>;
  violations: string[];
  done: boolean;
}
const state: PageState = { results: {}, durable: {}, errors: {}, violations: [], done: false };
Reflect.set(globalThis, 'adkGo', state);
addEventListener('securitypolicyviolation', (event) =>
  state.violations.push(
    `${event.effectiveDirective} ${event.sourceFile}:${event.lineNumber} ${event.sample}`,
  ),
);

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

/** Storage in the page's IndexedDB that every runtime of a case reopens, as a reload does. */
function indexedDb(name: string): Durability & { remove(): Promise<void> } {
  const databaseName = `adk-go-durable-${name}`;
  return {
    async open() {
      const saver = await IndexedDBSaver.open({
        databaseName,
        appId: `adk-go-${name}`,
        principalScope: 'fixture',
      });
      return {
        checkpoints: saver.byteRecords,
        recovery: saver.recovery,
        close: () => saver.close(),
      };
    },
    remove: () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(databaseName);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Database cleanup was blocked.'));
      }),
  };
}

for (const [name, script] of Object.entries(REFERENCE_SCRIPTS)) {
  if ((script.answers?.length ?? 0) === 0) continue;
  const storage = indexedDb(name);
  try {
    state.durable[name] = await runCase(
      name,
      script,
      wasm,
      () => new Worker(allowed, { type: 'module' }) as unknown as GoWorkerPort,
      storage,
    );
  } catch (error) {
    state.errors[`durable:${name}`] = String(error);
  } finally {
    await storage.remove().catch((error: unknown) => {
      state.errors[`cleanup:${name}`] = String(error);
    });
  }
}
state.done = true;
