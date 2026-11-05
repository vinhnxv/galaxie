// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';

export interface WebLLMWorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

interface WorkerHandler {
  postMessage(message: unknown): void;
  onmessage(event: MessageEvent): void;
}

const started = new WeakSet<WebLLMWorkerScope>();

/** Hosts call this from their bundled inference worker entry. Importing it starts nothing. */
export function startWebLLMWorker(scope: WebLLMWorkerScope = self): void {
  if ('document' in scope) throw new Error('The WebLLM worker requires a worker scope.');
  if (started.has(scope)) throw new Error('The WebLLM worker is already started.');
  const Handler = WebWorkerMLCEngineHandler as new () => WorkerHandler;
  const handler = new Handler();
  handler.postMessage = (message): void => scope.postMessage(message);
  scope.addEventListener('message', (event) => handler.onmessage(event));
  started.add(scope);
}
