// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test, vi } from 'vitest';
import * as args from '../src/args.js';
import * as composer from '../src/compose.js';
import * as guidance from '../src/guidance.js';
import * as installer from '../src/install.js';
import * as layers from '../src/layers.js';
import { run } from '../src/main.js';
import * as packages from '../src/packages.js';
import * as paths from '../src/paths.js';
import * as prompts from '../src/prompt.js';
import * as writer from '../src/write.js';

vi.mock('node:fs/promises', { spy: true });

function fail(): never {
  throw new Error('private-error-canary');
}

test.each([
  {
    step: 'read the create version',
    inject: () => vi.spyOn(fs, 'readFile').mockImplementationOnce(fail),
  },
  {
    step: 'load template layers',
    inject: () => vi.spyOn(layers, 'loadLayers').mockImplementationOnce(fail),
  },
  {
    step: 'parse arguments',
    inject: () => vi.spyOn(args, 'parseArguments').mockImplementationOnce(fail),
  },
  {
    step: 'prompt for project choices',
    inject: () => vi.spyOn(prompts, 'prompt').mockImplementationOnce(fail),
  },
  {
    step: 'validate the project target',
    inject: () => vi.spyOn(paths, 'validateTarget').mockImplementationOnce(fail),
  },
  {
    step: 'resolve local tarballs',
    inject: () => vi.spyOn(packages, 'resolveTarballs').mockImplementationOnce(fail),
  },
  {
    step: 'load project guidance',
    inject: () => vi.spyOn(guidance, 'loadGuidanceSource').mockImplementationOnce(fail),
  },
  {
    step: 'compose the project',
    inject: () => vi.spyOn(composer, 'compose').mockImplementationOnce(fail),
  },
  {
    step: 'plan project writes',
    inject: () => vi.spyOn(writer, 'planWrite').mockImplementationOnce(fail),
  },
  {
    step: 'write the project',
    inject: () => vi.spyOn(writer, 'writeProject').mockImplementationOnce(fail),
  },
  {
    step: 'install project dependencies',
    inject: () => vi.spyOn(installer, 'install').mockImplementationOnce(fail),
  },
])('unexpected failures identify $step without error contents', async ({ step, inject }) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'galaxie-create-step-'));
  onTestFinished(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stderr = new PassThrough();
  let errors = '';
  stderr.on('data', (bytes: Buffer) => {
    errors += bytes.toString();
  });
  inject();
  expect(
    await run(
      step === 'read the create version'
        ? ['--version']
        : step === 'prompt for project choices'
          ? []
          : ['my-app', 'browser-only', 'langgraph-js'],
      {
        cwd: root,
        templatesRoot: fileURLToPath(new URL('../../../templates', import.meta.url)),
        guidanceRoot: fileURLToPath(new URL('../../../skills/galaxie', import.meta.url)),
        stdin,
        stdout,
        stderr,
        env: step === 'resolve local tarballs' ? { GALAXIE_CREATE_PACKAGE_DIR: root } : {},
      },
    ),
  ).toBe(1);
  expect(errors).toBe(`Failed to ${step}.\n`);
});

test('every step label in main.ts has a failure case above', () => {
  const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const labels = [...source.matchAll(/step = '([^']+)'/g)].map((match) => match[1]);
  const pinned = readFileSync(new URL(import.meta.url), 'utf8');
  for (const label of labels) expect(pinned).toContain(`step: '${label}'`);
  expect(labels).toHaveLength(11);
});
