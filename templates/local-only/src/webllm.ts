// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { WebLLMEngineHandle } from '@galaxie-ai/models/webllm';
import type { DownloadOptions } from './runtime.js';
import workerUrl from './webllm-worker.ts?worker&url';

interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
}

let installed = false;

/** Imported only after consent; the policy permits only this bundled worker. */
export async function downloadWebLLM(options: DownloadOptions): Promise<WebLLMEngineHandle> {
  const { loadWebLLMEngine } = await import('@galaxie-ai/models/webllm');
  options.signal.throwIfAborted();
  const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypesFactory })
    .trustedTypes;
  if (factory !== undefined && !installed) {
    const allowed = new URL(workerUrl, location.href);
    factory.createPolicy('default', {
      createScriptURL(value) {
        const candidate = new URL(value, location.href);
        if (candidate.origin !== location.origin || candidate.href !== allowed.href)
          throw new TypeError('The worker script URL is not allowed.');
        return candidate.href;
      },
    });
    installed = true;
  }
  return loadWebLLMEngine({
    worker: new Worker(new URL('./webllm-worker.ts', import.meta.url), { type: 'module' }),
    ...options,
  });
}
