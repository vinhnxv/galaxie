// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile, resolveConfig } from 'vite';

const { frameworkProfile } = (await import(
  new URL('../src/framework-profile.ts', import.meta.url).href
)) as { frameworkProfile: { readonly workers: boolean } };

const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string> };

test('the framework profile matches the installed framework', () => {
  // The profile is editable source, so it must be bound to the dependency that needs workers.
  assert.equal(
    frameworkProfile.workers,
    manifest.dependencies?.['@galaxie-ai/starter-go'] !== undefined ||
      manifest.dependencies?.['@galaxie-ai/starter-python'] !== undefined,
    'framework profile changed',
  );
});

const headers: Readonly<Record<string, string>> = frameworkProfile.workers
  ? {
      production:
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://huggingface.co https://*.hf.co https://raw.githubusercontent.com; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; manifest-src 'self'; require-trusted-types-for 'script'; trusted-types default",
      mock: "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; manifest-src 'self'; require-trusted-types-for 'script'; trusted-types default",
    }
  : {
      production:
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' https://huggingface.co https://*.hf.co https://raw.githubusercontent.com; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; manifest-src 'self'; require-trusted-types-for 'script'; trusted-types default",
      mock: "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; manifest-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'",
    };

function assertHeader(actual: unknown, expected: string, location: string): void {
  assert.ok(typeof actual === 'string', `${location}: Content-Security-Policy header is missing`);
  const directives = new Map(
    actual.split('; ').map((entry) => {
      const [name, ...sources] = entry.split(' ');
      return [name, sources.join(' ')];
    }),
  );
  assert.equal(
    directives.get('require-trusted-types-for'),
    "'script'",
    `${location}: require-trusted-types-for changed`,
  );
  assert.equal(
    directives.get('trusted-types'),
    expected.endsWith("trusted-types 'none'") ? "'none'" : 'default',
    `${location}: trusted-types changed`,
  );
  for (const entry of expected.split('; ')) {
    const [name, ...sources] = entry.split(' ');
    assert.equal(directives.get(name), sources.join(' '), `${location}: ${name} changed`);
  }
  assert.equal(actual, expected, `${location}: Content-Security-Policy changed`);
}

for (const [mode, expected] of Object.entries(headers)) {
  test(`Vite emits the pinned CSP and Trusted Types in ${mode} mode`, async () => {
    const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
    const declared = await loadConfigFromFile(
      { command: 'serve', mode },
      configFile,
      undefined,
      'silent',
    );
    assert.ok(declared, 'Vite configuration is missing');
    // Vite inherits server headers when preview headers are absent; keep both paths explicit.
    assertHeader(
      declared.config.preview?.headers?.['Content-Security-Policy'],
      expected,
      `${mode} preview declaration`,
    );
    const config = await resolveConfig(
      {
        configFile,
        mode,
        logLevel: 'silent',
      },
      'serve',
    );
    assertHeader(config.server.headers?.['Content-Security-Policy'], expected, `${mode} server`);
    assertHeader(config.preview.headers?.['Content-Security-Policy'], expected, `${mode} preview`);
  });
}
