// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { loadGoWasm, workerLoaderEnvironment } from './loader.js';
import { encodeWorkerMessage, parseBoot, validUrl, type WorkerMessage } from './protocol.js';

// Module Workers cannot run classic scripts; fail before any caller reaches that unsupported call.
Reflect.set(globalThis, 'importScripts', (): never => {
  throw new TypeError('Classic scripts are unavailable in a module Worker.');
});

function send(message: WorkerMessage): void {
  globalThis.postMessage(encodeWorkerMessage(message));
}

function sameOrigin(url: string): boolean {
  return validUrl(url, location.href) && new URL(url, location.href).origin === location.origin;
}

// The host entry imports the hash-checked `wasm_exec.js` before this module, so `Go` is defined.
let booted = false;
async function boot(data: unknown): Promise<void> {
  if (booted) return;
  booted = true;
  const started = performance.now();
  try {
    const message = parseBoot(data);
    if (!sameOrigin(message.wasm.url)) throw new TypeError('Origin.');
    const loaded = await loadGoWasm(
      { ...message.wasm, url: new URL(message.wasm.url, location.href).href },
      workerLoaderEnvironment(globalThis as unknown as Record<string, unknown>),
    );
    send({ v: 1, kind: 'ready', coldStartMs: Math.round(performance.now() - started) });
    void loaded.exited.then((code) => send({ v: 1, kind: 'exit', code }));
  } catch {
    send({ v: 1, kind: 'failed' });
  }
}

addEventListener('message', (event: MessageEvent<unknown>) => {
  void boot(event.data);
});
