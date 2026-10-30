// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import retrievalUrl from '../retrieval/worker.ts?worker&url';
import pyodideUrl from './pyodide-worker.ts?worker&url';
import webllmUrl from './webllm-worker.ts?worker&url';

interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
}
let installed = false;
export function checkWorkerUrl(value: string, allowed: readonly string[], base: string): string {
  const candidate = new URL(value, base);
  if (
    candidate.origin !== new URL(base).origin ||
    !allowed.some((url) => new URL(url, base).href === candidate.href)
  )
    throw new TypeError('The worker script URL is not allowed.');
  return candidate.href;
}
export function allowWorkerScripts(): void {
  if (installed) return;
  const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypesFactory })
    .trustedTypes;
  if (factory)
    factory.createPolicy('default', {
      createScriptURL: (value) =>
        checkWorkerUrl(value, [retrievalUrl, webllmUrl, pyodideUrl], location.href),
    });
  installed = true;
}
export function createRetrievalWorker(): Worker {
  allowWorkerScripts();
  return new Worker(retrievalUrl, { type: 'module' });
}
export function createWebLLMWorker(): Worker {
  allowWorkerScripts();
  return new Worker(webllmUrl, { type: 'module' });
}
export function createPyodideWorker(): Worker {
  allowWorkerScripts();
  return new Worker(pyodideUrl, { type: 'module' });
}
