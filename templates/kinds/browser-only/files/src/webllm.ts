// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { WebLLMEngineHandle } from '@galaxie-ai/models/webllm';
import type { DownloadOptions } from './runtime.js';
import workerUrl from './webllm-worker.ts?worker&url';
import { createWorker } from './worker-policy.js';

/** Imported only after consent; the policy permits only host-selected bundled workers. */
export async function downloadWebLLM(options: DownloadOptions): Promise<WebLLMEngineHandle> {
  const { loadWebLLMEngine } = await import('@galaxie-ai/models/webllm');
  options.signal.throwIfAborted();
  return loadWebLLMEngine({ worker: createWorker(workerUrl), ...options });
}
