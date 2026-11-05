// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import pyodideUrl from './pyodide-worker.ts?worker&url';

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

export function createPyodideWorker(): Worker {
  if (!installed) {
    const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypesFactory })
      .trustedTypes;
    factory?.createPolicy('default', {
      createScriptURL: (value) => checkWorkerUrl(value, [pyodideUrl], location.href),
    });
    installed = true;
  }
  return new Worker(pyodideUrl, { type: 'module' });
}
