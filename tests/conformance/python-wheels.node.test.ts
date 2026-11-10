// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

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

test('CPython and Pyodide locks agree except for the exact documented cryptography pair', async () => {
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
    if (item.name === 'cryptography') {
      // ADR-0022 records the sole platform difference and the unavailable patched WASM wheel.
      expect({ native: nativeVersion, pyodide: item.version }).toEqual({
        native: '50.0.2',
        pyodide: '47.0.0',
      });
    } else if (nativeVersion !== undefined) expect(nativeVersion, item.name).toBe(item.version);
  }
  expect(versions.get('langgraph')).toBe('1.2.16');
  expect(versions.get('langchain-core')).toBe('1.7.0');
  expect(lock.packages.find((item) => item.name === 'msgpack')?.version).toBe('1.2.4');
});

test('framework wheel sets preserve the LangGraph inventory and keep provider SDKs out', async () => {
  const inventory = lockedWheels;
  for (const wheel of inventory) {
    expect(wheel.frameworks, wheel.name).toBeDefined();
    expect(wheel.frameworks?.length, wheel.name).toBeGreaterThan(0);
    expect(
      wheel.frameworks?.every((framework) =>
        ['langgraph', 'pydantic-ai', 'dspy', 'adk'].includes(framework),
      ),
    ).toBe(true);
  }
  const langgraph = inventory.filter((wheel) => wheel.frameworks?.includes('langgraph'));
  expect(langgraph.reduce((sum, wheel) => sum + wheel.bytes, 0)).toBe(6_045_432);
  const fingerprint = langgraph
    .map(
      (wheel) =>
        `${wheel.name} ${wheel.version} ${wheel.file} ${wheel.bytes} ${wheel.sha256} ${wheel.url}`,
    )
    .join('\n');
  expect(createHash('sha256').update(fingerprint).digest('hex')).toBe(
    'bcf53369f41c241c62bddd69d02315297cfdc7af5d4ddae9020ca66dc47ecc7d',
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
  const adk = inventory.filter((wheel) => wheel.frameworks?.includes('adk'));
  for (const wheel of [...pydantic, ...dspy, ...adk]) {
    const block = native
      .split('[[package]]')
      .find((item) => item.startsWith(`\nname = "${wheel.name}"\n`));
    const uploadTimes = [...(block ?? '').matchAll(/upload-time = "([^"]+)"/g)];
    expect(uploadTimes.length, wheel.name).toBeGreaterThan(0);
    for (const match of uploadTimes)
      expect(Date.parse(match[1] ?? '')).toBeLessThan(Date.parse('2026-11-03T00:00:00Z'));
  }
});

test('the ADK wheel set is the pinned closure, with servers, SDKs and cloud clients kept out', async () => {
  const adk = lockedWheels.filter((wheel) => wheel.frameworks?.includes('adk'));
  expect(adk).toHaveLength(29);
  expect(adk.reduce((sum, wheel) => sum + wheel.bytes, 0)).toBe(12_622_878);
  expect(
    createHash('sha256')
      .update(
        adk
          .map(
            (wheel) =>
              `${wheel.name} ${wheel.version} ${wheel.file} ${wheel.bytes} ${wheel.sha256} ${wheel.url}`,
          )
          .join('\n'),
      )
      .digest('hex'),
  ).toBe('afbf242ab7af557c7cf973b4a76caff2f3225d0acbf60f7457799345752c3b98');
  const only = lockedWheels.filter(
    (wheel) => wheel.frameworks?.length === 1 && wheel.frameworks[0] === 'adk',
  );
  expect(only.map((wheel) => `${wheel.name} ${wheel.version} ${wheel.bytes}`)).toEqual([
    'annotated-doc 0.0.5 5302',
    'authlib 1.9.1 266042',
    'cryptography 47.0.0 2174338',
    'fastapi 0.161.1 149049',
    'google-adk 2.12.0 4998446',
    'google-auth 2.62.0 267911',
    'google-genai 2.33.0 1222487',
    'joserfc 1.7.7 71758',
    'opentelemetry-semantic-conventions 0.66b1 206279',
    'starlette 1.9.0 80335',
  ]);
  const forbidden = (name: string): boolean =>
    [
      'watchdog',
      'uvicorn',
      'grpcio',
      'opentelemetry-sdk',
      'mcp',
      'click',
      'aiosqlite',
      'graphviz',
      'python-dotenv',
      'python-multipart',
    ].includes(name) ||
    name.startsWith('pyasn1') ||
    name.startsWith('google-cloud-');
  expect(lockedWheels.filter((wheel) => forbidden(wheel.name))).toEqual([]);
});

test('native framework and extension pins match the maintained constraints', async () => {
  const native = await readFile(new URL('../../python/uv.lock', import.meta.url), 'utf8');
  const versions = new Map(
    [...native.matchAll(/\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const pinned: Record<string, string> = {
    pydantic: '2.12.5',
    'pydantic-core': '2.41.5',
    'opentelemetry-api': '1.45.1',
    'opentelemetry-semantic-conventions': '0.66b1',
    tenacity: '9.2.1',
    websockets: '17.3',
    cryptography: '50.0.2',
    msgpack: '1.2.4',
    pyasn1: '0.6.5',
    cffi: '2.0.0',
    pycparser: '3.0',
    'google-adk': '2.12.0',
    'google-genai': '2.33.0',
    langgraph: '1.2.16',
    'langchain-core': '1.7.0',
    dspy: '3.4.1',
    'pydantic-ai-slim': '2.60.0',
  };
  for (const [name, version] of Object.entries(pinned))
    expect(versions.get(name), name).toBe(version);
  // The overrides and constraints that hold those pins stay declared in the project file.
  const project = await readFile(new URL('../../python/pyproject.toml', import.meta.url), 'utf8');
  for (const pin of [
    'opentelemetry-api==1.45.1',
    'opentelemetry-semantic-conventions==0.66b1',
    'tenacity==9.2.1',
    'websockets==17.3',
    'cryptography==50.0.2',
    'msgpack==1.2.4',
    'pyasn1==0.6.5',
    'cffi==2.0.0',
    'pycparser==3.0',
  ])
    expect(project, pin).toContain(`"${pin}"`);
});
