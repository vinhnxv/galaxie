// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { lockedWheels } from '../../packages/adapter-pyodide/src/runtime-files.js';
import { fetchWheel, type LockedWheel } from '../../scripts/fetch-python-wheels.js';

test('wheel fetch accepts pinned bytes and rejects changed bytes without leaving a file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-wheel-'));
  const bytes = new TextEncoder().encode('synthetic wheel body');
  const wheel: LockedWheel = {
    name: 'fixture',
    version: '1.0',
    file: 'fixture-1.0-py3-none-any.whl',
    url: 'https://files.pythonhosted.org/fixture.whl',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  try {
    const changed = bytes.slice();
    changed[0] = (changed[0] ?? 0) ^ 1;
    await expect(fetchWheel(wheel, directory, async () => new Response(changed))).rejects.toThrow(
      'The Python wheel could not be verified.',
    );
    expect(await readdir(directory)).toEqual([]);
    await fetchWheel(wheel, directory, async (_url, init) => {
      expect(init?.credentials).toBe('omit');
      return new Response(bytes);
    });
    expect(new Uint8Array(await readFile(join(directory, wheel.file)))).toEqual(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CPython and Pyodide locks agree on every shared distribution version', async () => {
  const lock = JSON.parse(
    await readFile(new URL('../../python/requirements.lock', import.meta.url), 'utf8'),
  ) as { packages: LockedWheel[] };
  expect(lockedWheels).toEqual(lock.packages);
  const native = await readFile(new URL('../../python/uv.lock', import.meta.url), 'utf8');
  const versions = new Map(
    [...native.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)].map((match) => [
      match[1]?.replaceAll('_', '-').toLowerCase(),
      match[2],
    ]),
  );
  for (const item of lock.packages) {
    const nativeVersion = versions.get(item.name.replaceAll('_', '-').toLowerCase());
    if (nativeVersion !== undefined) expect(nativeVersion, item.name).toBe(item.version);
  }
  expect(versions.get('langgraph')).toBe('1.2.16');
  expect(versions.get('langchain-core')).toBe('1.7.0');
  expect(lock.packages.find((item) => item.name === 'msgpack')?.version).toBe('1.1.2');
});
