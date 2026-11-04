// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { loadGoWasm, workerLoaderEnvironment } from './loader.js';
import {
  type BridgeOp,
  encodeWorkerMessage,
  MAX_BRIDGE_BYTES,
  parseBoot,
  parseHostMessage,
  validBuildInfo,
  validUrl,
  type WorkerMessage,
} from './protocol.js';

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

interface Pending {
  readonly resolve: (payload: string) => void;
  readonly reject: (error: Error) => void;
}

/** The one active run and the calls the Go program has in flight for it. */
let activeRun: string | undefined;
let nextCall = 0;
const pending = new Map<string, Pending>();

/** Go reaches the page only through this object; every call is one bounded message. */
const bridge = {
  call(op: BridgeOp, payload: string): Promise<string> {
    const runId = activeRun;
    if (runId === undefined || new TextEncoder().encode(payload).byteLength > MAX_BRIDGE_BYTES)
      return Promise.reject(new Error('invalid'));
    const id = `c${++nextCall}`;
    return new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ v: 1, kind: 'call', runId, id, op, payload });
    });
  },
};

function rejectPending(code: string): void {
  for (const call of pending.values()) call.reject(new Error(code));
  pending.clear();
}

function goHandle(): { run?: (request: string) => Promise<string>; cancel?: () => void } {
  const value: unknown = Reflect.get(globalThis, 'galaxieGo');
  return typeof value === 'object' && value !== null ? value : {};
}

async function run(runId: string, request: string): Promise<void> {
  activeRun = runId;
  let result = JSON.stringify({ ok: false, code: 'unavailable' });
  try {
    const handle = goHandle();
    if (typeof handle.run === 'function') result = await handle.run(request);
  } catch {
    // A Go program that panicked or exited cannot answer: the run fails with the fixed code.
    result = JSON.stringify({ ok: false, code: 'unavailable' });
  }
  rejectPending('cancelled');
  activeRun = undefined;
  send({ v: 1, kind: 'done', runId, result });
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
    Reflect.set(globalThis, 'galaxieBridge', bridge);
    const loaded = await loadGoWasm(
      { ...message.wasm, url: new URL(message.wasm.url, location.href).href },
      workerLoaderEnvironment(globalThis as unknown as Record<string, unknown>),
    );
    let build: unknown;
    try {
      build = loaded.build === undefined ? undefined : JSON.parse(loaded.build);
    } catch {
      build = undefined;
    }
    send({
      v: 1,
      kind: 'ready',
      coldStartMs: Math.round(performance.now() - started),
      ...(validBuildInfo(build) ? { build } : {}),
    });
    void loaded.exited.then((code) => {
      rejectPending('unavailable');
      send({ v: 1, kind: 'exit', code });
    });
  } catch {
    send({ v: 1, kind: 'failed' });
  }
}

function handle(data: unknown): void {
  const message = parseHostMessage(data);
  if (!message) return;
  if (message.kind === 'run') {
    if (activeRun === undefined) void run(message.runId, message.request);
    else
      send({ v: 1, kind: 'done', runId: message.runId, result: '{"ok":false,"code":"invalid"}' });
  } else if (message.kind === 'cancel') {
    if (message.runId === activeRun) goHandle().cancel?.();
  } else if (message.kind === 'reply') {
    const call = pending.get(message.id);
    if (!call || message.runId !== activeRun) return;
    pending.delete(message.id);
    if (message.ok) call.resolve(message.payload);
    else call.reject(new Error(message.code));
  }
}

addEventListener('message', (event: MessageEvent<unknown>) => {
  if (booted) handle(event.data);
  else void boot(event.data);
});
