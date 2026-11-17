// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultWebLLMModel } from '@galaxie-ai/models/webllm';
import { expect, it } from 'vitest';
import { templateDefinition } from '../src/executor.js';
import {
  controlLabels,
  modelStates,
  webLLMWeightBytes,
  webLLMWeightMB,
} from '../src/model-state.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const framework = JSON.parse(
  await readFile(
    resolve(root, '../../../../../templates/frameworks', templateDefinition.executor, 'layer.json'),
    'utf8',
  ),
) as { package: { dependencies: Record<string, string> } };
const coreVersion = JSON.parse(
  await readFile(resolve(root, '../../../../../packages/core/package.json'), 'utf8'),
) as { version: string };
const frameworkDependencies = framework.package.dependencies;
const launch = [
  '@galaxie-ai/core',
  ...Object.keys(frameworkDependencies).filter((name) => name.startsWith('@galaxie-ai/')),
  '@galaxie-ai/models',
  '@galaxie-ai/storage-indexeddb',
  '@galaxie-ai/react',
];
const reasons = [
  'no_webgpu',
  'no_adapter',
  'no_shader_f16',
  'adapter_limits',
  'device_lost',
  'integrity',
  'worker_failed',
  'load_failed',
  'disposed',
  'no_api',
  'unsupported_languages',
  'download_required',
  'activation_required',
  'download_failed',
  'not_allowed',
  'rate_limited',
  'endpoint_failed',
  'network',
];

it('covers every typed reason and phase with fixed text and at most one control', () => {
  expect(Object.keys(modelStates).sort()).toEqual(
    [...reasons, 'offer', 'downloading', 'failed', 'declined', 'ready'].sort(),
  );
  for (const entry of Object.values(modelStates)) {
    expect(entry.message.trim().length).toBeGreaterThan(0);
    expect(entry.message).not.toMatch(/https?:|www\.|\$\{|<script|user-text-canary/i);
    expect(entry.control === null || Object.hasOwn(controlLabels, entry.control)).toBe(true);
    expect(Object.keys(entry).sort()).toEqual(['control', 'message']);
  }
  expect(modelStates.offer.control).toBe('download');
  expect(modelStates.downloading.control).toBe('cancel');
  expect(modelStates.failed.control).toBe('retry');
  expect(modelStates.declined.control).toBe('download-again');
  expect(modelStates.ready.control).toBeNull();
  expect(modelStates.no_webgpu.control).toBeNull();
  expect(webLLMWeightBytes).toBe(defaultWebLLMModel.weightBytes);
  expect(webLLMWeightMB).toBe(defaultWebLLMModel.weightBytes / 1_000_000);
  expect(modelStates.offer.message).toContain('868,547,584 bytes (868.547584 MB)');
});

it('declares only launch packages with registry-compatible ranges and the pinned third parties', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
    name: string;
    private: boolean;
    license: string;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  expect(manifest).toMatchObject({
    name: `browser-only-${templateDefinition.executor}`,
    private: true,
    license: 'Apache-2.0',
  });
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  expect(
    Object.keys(dependencies)
      .filter((name) => name.startsWith('@galaxie-ai/'))
      .sort(),
  ).toEqual([...launch].sort());
  for (const name of launch) expect(dependencies[name]).toBe(`^${coreVersion.version}`);
  expect(
    Object.fromEntries(
      Object.entries(dependencies).filter(([name]) => !name.startsWith('@galaxie-ai/')),
    ),
  ).toEqual({
    ...Object.fromEntries(
      Object.entries(frameworkDependencies).filter(([name]) => !name.startsWith('@galaxie-ai/')),
    ),
    react: '19.3.1',
    'react-dom': '19.3.1',
    '@mlc-ai/web-llm': '0.2.86',
    vite: '8.3.4',
    playwright: '1.64.1',
    typescript: '7.0.2',
    '@types/node': '24.19.2',
    '@types/react': '19.3.0',
    '@types/react-dom': '19.3.0',
  });
  for (const version of Object.values(dependencies)) expect(version).not.toContain('workspace:');
});

async function sources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? sources(resolve(directory, entry.name))
          : Promise.resolve(/\.tsx?$/.test(entry.name) ? [resolve(directory, entry.name)] : []),
      ),
    )
  ).flat();
}

it('keeps source imports inside the template or the five launch packages and defers WebLLM', async () => {
  for (const file of await sources(resolve(root, 'src'))) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (specifier === undefined) throw new Error('The import has no specifier.');
      if (specifier.startsWith('@galaxie-ai/'))
        expect(launch).toContain(specifier.split('/').slice(0, 2).join('/'));
      if (specifier.startsWith('.')) {
        const path = relative(root, resolve(dirname(file), specifier));
        expect(path.startsWith('..') || isAbsolute(path)).toBe(false);
      }
    }
    // Type imports erase; runtime provider and engine imports must remain dynamic.
    const executable = source.replace(/import\s+type\s+[\s\S]*?;/g, '');
    expect(executable).not.toMatch(/from\s*['"]@(?:galaxie-ai\/models\/webllm|mlc-ai\/web-llm)/);
    expect(executable).not.toMatch(/import\s*['"]@mlc-ai\/web-llm/);
  }
});
