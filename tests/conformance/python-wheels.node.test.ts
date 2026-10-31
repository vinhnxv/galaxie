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

test('framework wheel sets preserve the LangGraph inventory and keep provider SDKs out', async () => {
  const inventory = lockedWheels;
  for (const wheel of inventory) {
    expect(wheel.frameworks, wheel.name).toBeDefined();
    expect(wheel.frameworks?.length, wheel.name).toBeGreaterThan(0);
    expect(
      wheel.frameworks?.every((framework) =>
        ['langgraph', 'pydantic-ai', 'dspy'].includes(framework),
      ),
    ).toBe(true);
  }
  const langgraph = inventory.filter((wheel) => wheel.frameworks?.includes('langgraph'));
  expect(langgraph.reduce((sum, wheel) => sum + wheel.bytes, 0)).toBe(6_042_342);
  const fingerprint = langgraph
    .map(
      (wheel) =>
        `${wheel.name} ${wheel.version} ${wheel.file} ${wheel.bytes} ${wheel.sha256} ${wheel.url}`,
    )
    .join('\n');
  expect(createHash('sha256').update(fingerprint).digest('hex')).toBe(
    'af0f855f9a3ad22e27237d198f94a690d7e05ca54ebeb9ae6b8b2de165582cd1',
  );
  const pydantic = inventory.filter((wheel) => wheel.frameworks?.includes('pydantic-ai'));
  expect(pydantic.reduce((sum, wheel) => sum + wheel.bytes, 0)).toBe(5_208_632);
  expect(
    createHash('sha256')
      .update(
        pydantic
          .map(
            (wheel) =>
              `${wheel.name} ${wheel.version} ${wheel.file} ${wheel.bytes} ${wheel.sha256} ${wheel.url}`,
          )
          .join('\n'),
      )
      .digest('hex'),
  ).toBe('e576cc156d67f2e33e275c6eb8c750cc32c8449264f7a11a07602adae3b0ef16');
  const dspy = inventory.filter((wheel) => wheel.frameworks?.includes('dspy'));
  expect(dspy.reduce((sum, wheel) => sum + wheel.bytes, 0)).toBe(4_431_463);
  expect(dspy.find((wheel) => wheel.name === 'dspy')?.version).toBe('3.4.1');
  expect(
    dspy.some((wheel) =>
      ['openai', 'litellm', 'gepa', 'tenacity', 'diskcache', 'cachetools', 'jiter'].includes(
        wheel.name,
      ),
    ),
  ).toBe(false);
  expect(pydantic.find((wheel) => wheel.name === 'pydantic-ai-slim')?.version).toBe('2.60.0');
  expect(pydantic.find((wheel) => wheel.name === 'pydantic-graph')?.version).toBe('2.60.0');
  expect(inventory.some((wheel) => ['openai', 'jiter', 'pydantic-ai'].includes(wheel.name))).toBe(
    false,
  );
  const native = await readFile(new URL('../../python/uv.lock', import.meta.url), 'utf8');
  for (const wheel of [...pydantic, ...dspy]) {
    const block = native
      .split('[[package]]')
      .find((item) => item.startsWith(`\nname = "${wheel.name}"\n`));
    const uploadTimes = [...(block ?? '').matchAll(/upload-time = "([^"]+)"/g)];
    expect(uploadTimes.length, wheel.name).toBeGreaterThan(0);
    for (const match of uploadTimes)
      expect(Date.parse(match[1] ?? '')).toBeLessThan(Date.parse('2026-10-23T17:00:00Z'));
  }
});
