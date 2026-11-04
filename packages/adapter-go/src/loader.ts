// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { adapterFailure } from './errors.js';
import type { GoWasmReference } from './protocol.js';

/** The part of Go's `wasm_exec.js` runtime the loader drives. */
export interface GoGlue {
  readonly importObject: WebAssembly.Imports;
  exit: (code: number) => void;
  run(instance: WebAssembly.Instance): Promise<void>;
}

export interface GoLoaderEnvironment {
  /** Fetches the module bytes; captured before the egress stubs replace the global. */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  readonly digest: (bytes: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;
  readonly compile: (bytes: Uint8Array<ArrayBuffer>) => Promise<WebAssembly.Module>;
  readonly instantiate: (
    module: WebAssembly.Module,
    imports: WebAssembly.Imports,
  ) => Promise<WebAssembly.Instance>;
  readonly createGo: () => GoGlue;
  /** The global the Go program reads: `galaxieReady`, the egress surfaces and `fs`. */
  readonly scope: Record<string, unknown>;
}

/** How long each loading phase took, in milliseconds. */
export interface GoLoadTimings {
  /** Fetching the bytes and checking their length and digest. */
  readonly fetchMs: number;
  /** Compiling and instantiating the module. */
  readonly compileMs: number;
  /** Starting the Go runtime until the program reports ready. */
  readonly startMs: number;
}

export interface LoadedGo {
  /** Resolves with the exit code when the Go program ends; the Worker is then dead. */
  readonly exited: Promise<number>;
  /** How many times Go code reached a blocked network surface. */
  readonly egressAttempts: () => number;
  readonly timings: GoLoadTimings;
}

/** Names the loader replaces before Go code runs, so ordinary Go networking fails closed. */
export const egressSurfaces: readonly string[] = [
  'fetch',
  'WebSocket',
  'EventSource',
  'XMLHttpRequest',
  'Worker',
  'SharedWorker',
];

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function installEgressStubs(scope: Record<string, unknown>, count: () => void): void {
  for (const name of egressSurfaces) {
    const blocked = function blocked(): never {
      count();
      throw new TypeError('Network access is not available to Go agents.');
    };
    Object.defineProperty(scope, name, { value: blocked, configurable: true, writable: true });
  }
}

/** Go standard output and error carry no data out of the Worker. */
function discardStandardStreams(scope: Record<string, unknown>): void {
  const fs = scope['fs'];
  if (typeof fs !== 'object' || fs === null) return;
  Reflect.set(fs, 'writeSync', (_fd: number, bytes: Uint8Array): number => bytes.length);
  Reflect.set(
    fs,
    'write',
    (
      _fd: number,
      _bytes: Uint8Array,
      _offset: number,
      length: number,
      _position: number | null,
      callback: (error: Error | null, written: number) => void,
    ): void => callback(null, length),
  );
}

/**
 * Fetches the module, checks its length and SHA-256, and only then compiles and starts it. Every
 * failure is the same fixed `unavailable` error; nothing is compiled or run before the digest
 * matches, and the egress stubs are in place before the first Go instruction.
 */
export async function loadGoWasm(
  reference: GoWasmReference,
  environment: GoLoaderEnvironment,
): Promise<LoadedGo> {
  const started = performance.now();
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    const response = await environment.fetch(reference.url, {
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) throw new Error('unavailable');
    // A declared length that disagrees with the reviewed one is refused before the body is read.
    const declared = response.headers.get('content-length');
    if (declared !== null && declared !== String(reference.bytes)) throw new Error('unavailable');
    bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== reference.bytes) throw new Error('unavailable');
    if (hex(await environment.digest(bytes)) !== reference.sha256) throw new Error('unavailable');
  } catch {
    throw adapterFailure('unavailable');
  }
  const fetched = performance.now();
  let attempts = 0;
  installEgressStubs(environment.scope, () => {
    attempts++;
  });
  discardStandardStreams(environment.scope);
  try {
    const go = environment.createGo();
    let code = 0;
    go.exit = (value: number): void => {
      code = value;
    };
    const ready = Promise.withResolvers<void>();
    Reflect.set(environment.scope, 'galaxieReady', (): void => ready.resolve());
    const module = await environment.compile(bytes);
    const instance = await environment.instantiate(module, go.importObject);
    const compiled = performance.now();
    const exited = go.run(instance).then(
      () => code,
      () => -1,
    );
    // A program that exits before it reports ready never serves a run.
    const early = exited.then(() => {
      throw adapterFailure('unavailable');
    });
    early.catch(() => undefined);
    await Promise.race([ready.promise, early]);
    const readyAt = performance.now();
    return {
      exited,
      egressAttempts: () => attempts,
      timings: {
        fetchMs: Math.round(fetched - started),
        compileMs: Math.round(compiled - fetched),
        startMs: Math.round(readyAt - compiled),
      },
    };
  } catch {
    throw adapterFailure('unavailable');
  }
}

/** The environment of a real Worker, after `wasm_exec.js` has defined `Go`. */
export function workerLoaderEnvironment(scope: Record<string, unknown>): GoLoaderEnvironment {
  const fetcher = scope['fetch'];
  const Go = scope['Go'];
  if (typeof fetcher !== 'function' || typeof Go !== 'function')
    throw adapterFailure('unavailable');
  return {
    fetch: (url, init) => fetcher.call(scope, url, init) as Promise<Response>,
    digest: (bytes) => crypto.subtle.digest('SHA-256', bytes),
    compile: (bytes) => WebAssembly.compile(bytes),
    instantiate: (module, imports) => WebAssembly.instantiate(module, imports),
    createGo: () => new (Go as new () => GoGlue)(),
    scope,
  };
}
