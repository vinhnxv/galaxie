// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type TransformersRuntime, transformersRuntime } from './runtime.js';
import { createWorkerHost } from './worker-host.js';

export type { TransformersRuntime } from './runtime.js';

export interface TransformersWorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  readonly location?: { readonly href: string };
}

export interface StartTransformersWorkerOptions {
  /**
   * The ORT WASM runtime files, bundled by the host as URLs (for example the
   * `onnxruntime-web/ort-wasm-simd-threaded.asyncify.{mjs,wasm}?url` imports). Relative URLs are
   * resolved against the Worker's location, so the strict CSP needs no new source.
   */
  readonly ort: { readonly mjs: string; readonly wasm: string };
  /** Replaces the Transformers.js runtime; tests and alternative engines supply their own. */
  readonly runtime?: TransformersRuntime;
}

const started = new WeakSet<TransformersWorkerScope>();

/** Hosts call this from their bundled inference worker entry. Importing it starts nothing. */
export function startTransformersWorker(
  options: StartTransformersWorkerOptions,
  scope: TransformersWorkerScope = self,
): void {
  if ('document' in scope) throw new Error('The Transformers worker requires a worker scope.');
  if (started.has(scope)) throw new Error('The Transformers worker is already started.');
  const base = scope.location?.href;
  const resolve = (url: string): string => (base === undefined ? url : new URL(url, base).href);
  const host = createWorkerHost({
    post: (message) => scope.postMessage(message),
    runtime: options.runtime ?? transformersRuntime,
    assets: { mjs: resolve(options.ort.mjs), wasm: resolve(options.ort.wasm) },
    openStore: async (name) => caches.open(name),
  });
  scope.addEventListener('message', (event) => host.receive(event.data));
  started.add(scope);
}
