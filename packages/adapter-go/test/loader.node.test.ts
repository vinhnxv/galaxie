// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { toErrorInfo } from '@galaxie/core';
import { expect, test, vi } from 'vitest';
import {
  egressSurfaces,
  type GoGlue,
  type GoLoaderEnvironment,
  loadGoWasm,
} from '../src/loader.js';

const module = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 7, 7, 7, 7]);
const reference = {
  url: 'http://127.0.0.1/go/agent.wasm',
  sha256: createHash('sha256').update(module).digest('hex'),
  bytes: module.byteLength,
};
const fixed = toErrorInfo('unavailable').message;

interface Harness {
  readonly environment: GoLoaderEnvironment;
  readonly log: string[];
  readonly compile: ReturnType<typeof vi.fn>;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly exit: (code: number) => void;
}

/** A fake runtime; `ready` decides whether the program reports ready after it starts. */
function harness(
  bytes: Uint8Array = module,
  options: { ready?: boolean; status?: number; contentLength?: number } = {},
): Harness {
  const log: string[] = [];
  const scope: Record<string, unknown> = {
    fs: { writeSync: () => 99, write: () => undefined },
  };
  for (const name of egressSurfaces) scope[name] = () => 'real';
  const fetch = vi.fn(async () => {
    log.push('fetch');
    return new Response(new Uint8Array(bytes), {
      status: options.status ?? 200,
      ...(options.contentLength === undefined
        ? {}
        : { headers: { 'content-length': String(options.contentLength) } }),
    });
  });
  const compile = vi.fn(async () => {
    log.push('compile');
    return {} as WebAssembly.Module;
  });
  let finish: () => void = () => undefined;
  const glue: GoGlue = {
    importObject: {},
    exit: () => undefined,
    run: () => {
      log.push(`stubbed:${(scope['fetch'] as () => string).name}`);
      if (options.ready !== false) (scope['galaxieReady'] as () => void)();
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  };
  const environment: GoLoaderEnvironment = {
    fetch,
    digest: (data) => crypto.subtle.digest('SHA-256', data),
    compile,
    instantiate: async () => ({}) as WebAssembly.Instance,
    createGo: () => glue,
    scope,
  };
  return {
    environment,
    log,
    compile,
    fetch,
    exit: (code) => {
      glue.exit(code);
      finish();
    },
  };
}

test('a verified module is compiled once, after the egress stubs are in place', async () => {
  const test_ = harness();
  const loaded = await loadGoWasm(reference, test_.environment);
  expect(test_.compile).toHaveBeenCalledTimes(1);
  expect(test_.log).toEqual(['fetch', 'compile', 'stubbed:blocked']);
  // Replacing the globals happened after the bytes were fetched with the original function.
  expect(test_.fetch).toHaveBeenCalledWith(reference.url, {
    credentials: 'omit',
    redirect: 'error',
  });
  for (const name of egressSurfaces) {
    expect(() => (test_.environment.scope[name] as () => void)(), name).toThrow(TypeError);
  }
  expect(loaded.egressAttempts()).toBe(egressSurfaces.length);
});

test('Go standard output and error are discarded', async () => {
  const test_ = harness();
  await loadGoWasm(reference, test_.environment);
  const fs = test_.environment.scope['fs'] as {
    writeSync(fd: number, bytes: Uint8Array): number;
    write(...args: unknown[]): void;
  };
  expect(fs.writeSync(1, new Uint8Array(5))).toBe(5);
  const callback = vi.fn();
  fs.write(2, new Uint8Array(3), 0, 3, null, callback);
  expect(callback).toHaveBeenCalledWith(null, 3);
});

test.each([
  [
    'a changed byte',
    () => harness(Uint8Array.from(module, (byte, index) => (index === 3 ? byte ^ 1 : byte))),
  ],
  ['a wrong length', () => harness(module.subarray(0, module.byteLength - 1))],
  ['a failed response', () => harness(module, { status: 404 })],
  [
    'a declared length that disagrees with the reference',
    () => harness(module, { contentLength: module.byteLength + 1 }),
  ],
])('%s fails before compile with the fixed error', async (_name, make) => {
  const test_ = make();
  await expect(loadGoWasm(reference, test_.environment)).rejects.toMatchObject({
    code: 'unavailable',
    message: fixed,
  });
  expect(test_.compile).not.toHaveBeenCalled();
  // No egress stub was installed either: nothing from the module ever ran.
  expect(test_.log).toEqual(['fetch']);
});

test('a wrong declared digest fails before compile', async () => {
  const test_ = harness();
  await expect(
    loadGoWasm({ ...reference, sha256: '0'.repeat(64) }, test_.environment),
  ).rejects.toMatchObject({ code: 'unavailable', message: fixed });
  expect(test_.compile).not.toHaveBeenCalled();
});

test('a program that exits before it reports ready fails unavailable', async () => {
  const test_ = harness(module, { ready: false });
  const loading = loadGoWasm(reference, test_.environment);
  await vi.waitFor(() => expect(test_.log).toContain('stubbed:blocked'));
  test_.exit(2);
  await expect(loading).rejects.toMatchObject({ code: 'unavailable', message: fixed });
});

test('a ready program reports its exit code when it ends', async () => {
  const test_ = harness();
  const loaded = await loadGoWasm(reference, test_.environment);
  test_.exit(2);
  await expect(loaded.exited).resolves.toBe(2);
});
