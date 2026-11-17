// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { expect, test } from 'vitest';
import { parse } from 'yaml';
import { shared, singleCopy } from '../src/single-copy.js';
import config from '../vitest.config.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const probes = {
  '@opentelemetry/api': '@opentelemetry/api',
  '@langchain/core': '@langchain/core/messages',
  '@langchain/langgraph': '@langchain/langgraph',
};

test.each(shared)('single-copy guard rejects a second installed %s directory', (name) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'llmops-single-copy-'));
  try {
    for (const dependency of shared)
      mkdirSync(resolve(directory, `${dependency.replace('/', '+')}@1.0.0`));
    expect(() => singleCopy(directory)).not.toThrow();
    mkdirSync(resolve(directory, `${name.replace('/', '+')}@2.0.0`));
    expect(() => singleCopy(directory)).toThrow(`Multiple installed copies of ${name}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('isolated lock contains one version of each shared package', () => {
  const lock = parse(readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')) as {
    packages: Record<string, unknown>;
  };
  for (const name of shared)
    expect(Object.keys(lock.packages).filter((key) => key.startsWith(`${name}@`))).toHaveLength(1);
});

test.skipIf(!existsSync(resolve(root, 'node_modules/.pnpm')))(
  'isolated installed virtual store passes the single-copy guard',
  () => expect(() => singleCopy(resolve(root, 'node_modules/.pnpm'))).not.toThrow(),
);

test('linked built packages share the runner module paths', async () => {
  const server = await createServer({
    ...config,
    configFile: false,
    root,
    server: { middlewareMode: true },
  });
  try {
    for (const [name, probe] of Object.entries(probes)) {
      const canonical = await server.environments['ssr']?.pluginContainer.resolveId(
        probe,
        resolve(root, 'test/single-copy.test.ts'),
      );
      expect(canonical?.id, `runner cannot resolve ${probe}`).toBeTruthy();
      for (const [linkedName, link] of Object.entries(manifest.dependencies)) {
        if (typeof link !== 'string' || !link.startsWith('link:')) continue;
        const directory = resolve(root, link.slice(5));
        const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
        const entries = Object.values(pkg.exports).map((value) => {
          const target =
            typeof value === 'string' ? value : (value as { default?: string }).default;
          if (typeof target !== 'string')
            throw new Error(`${linkedName}: export without a default`);
          return { default: target };
        });
        for (const exported of entries) {
          const entry = resolve(directory, exported.default);
          expect(
            existsSync(entry),
            `${linkedName}: missing ${entry}; run pnpm build at repo root`,
          ).toBe(true);
        }
        if (!(name in { ...pkg.dependencies, ...pkg.peerDependencies })) continue;
        for (const exported of entries) {
          const resolved = await server.environments['ssr']?.pluginContainer.resolveId(
            probe,
            resolve(directory, exported.default),
          );
          expect(resolved?.id, `${linkedName} resolves a second ${name}`).toBe(canonical?.id);
        }
      }
    }
  } finally {
    await server.close();
  }
});

test('unaliased linked-package resolution exposes a second API copy', async () => {
  const server = await createServer({ configFile: false, root, server: { middlewareMode: true } });
  try {
    const container = server.environments['ssr']?.pluginContainer;
    const runner = await container?.resolveId(
      '@opentelemetry/api',
      resolve(root, 'test/single-copy.test.ts'),
    );
    const linked = await container?.resolveId(
      '@opentelemetry/api',
      resolve(root, '../../packages/core/dist/index.js'),
    );
    expect(runner?.id).toBeTruthy();
    expect(linked?.id).toBeTruthy();
    expect(linked?.id).not.toBe(runner?.id);
  } finally {
    await server.close();
  }
});
