// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import goUrl from './go-worker.ts?worker&url';
import onnxUrl from './onnx-worker.ts?worker&url';
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

function createWorker(url: string): Worker {
  if (!installed) {
    const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypesFactory })
      .trustedTypes;
    factory?.createPolicy('default', {
      createScriptURL: (value) =>
        checkWorkerUrl(value, [pyodideUrl, goUrl, onnxUrl], location.href),
    });
    installed = true;
  }
  return new Worker(url, { type: 'module' });
}

export function createPyodideWorker(): Worker {
  return createWorker(pyodideUrl);
}

export function createGoWorker(): Worker {
  return createWorker(goUrl);
}

export function createOnnxWorker(): Worker {
  return createWorker(onnxUrl);
}
