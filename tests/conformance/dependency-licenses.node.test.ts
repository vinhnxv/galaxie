// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { checkDependencyLicenses } from '../../scripts/check-dependency-licenses.ts';

const dependency = {
  name: 'license-fixture',
  version: '1.0.0',
  launchPackage: '@galaxie/core',
  directory: 'unused',
};
const allowlist = { permissive: ['MIT'], exceptions: [] };

test('an MIT dependency passes', () => {
  const result = checkDependencyLicenses([dependency], () => ({ license: 'MIT' }), allowlist);
  expect(result.failures).toEqual([]);
});

test('a missing license fails and names the dependency', () => {
  const result = checkDependencyLicenses([dependency], () => ({}), allowlist);
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toContain('license-fixture@1.0.0');
  expect(result.failures[0]).toContain('UNKNOWN');
  expect(result.failures[0]).toContain('@galaxie/core');
});

test('a GPL dependency fails unless it has a reviewed exception', () => {
  const readLicense = (): { license: string } => ({ license: 'GPL-3.0' });
  const rejected = checkDependencyLicenses([dependency], readLicense, allowlist);
  expect(rejected.failures).toHaveLength(1);
  expect(rejected.failures[0]).toContain('license-fixture@1.0.0');
  expect(rejected.failures[0]).toContain('GPL-3.0');
  expect(rejected.failures[0]).toContain('@galaxie/core');
  const accepted = checkDependencyLicenses([dependency], readLicense, {
    ...allowlist,
    exceptions: [
      {
        package: dependency.name,
        license: 'GPL-3.0',
        reason: 'Test-only approval of the deliberately copyleft fixture.',
      },
    ],
  });
  expect(accepted.failures).toEqual([]);
});

test('an exception for a different license does not cover the dependency', () => {
  const result = checkDependencyLicenses([dependency], () => ({ license: 'AGPL-3.0' }), {
    ...allowlist,
    exceptions: [
      {
        package: dependency.name,
        license: 'GPL-3.0',
        reason: 'Test-only approval of the deliberately copyleft fixture.',
      },
    ],
  });
  expect(result.failures).toHaveLength(1);
});

test('an exception without a reason is rejected', () => {
  expect(() =>
    checkDependencyLicenses([dependency], () => ({ license: 'MIT' }), {
      ...allowlist,
      exceptions: [{ package: dependency.name, license: 'MIT', reason: '' }],
    }),
  ).toThrow(/license-fixture.*reason/);
});

function runCheck(): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['scripts/check-dependency-licenses.ts'], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
  });
}

test('the real lockfile has a non-empty runtime set including optional launch peers', () => {
  const result = runCheck();
  const output = String(result.stdout);
  expect(output, String(result.stderr)).toMatch(/Checked [1-9]\d* locked runtime dependencies/);
  for (const name of ['@langchain/core', '@mlc-ai/web-llm', '@huggingface/transformers', 'react']) {
    expect(output).toContain(`${name}@`);
  }
});

test('the real lockfile passes the dependency license check', () => {
  const result = runCheck();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});
