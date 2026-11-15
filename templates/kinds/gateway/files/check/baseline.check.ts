// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile, resolveConfig } from 'vite';

const header =
  "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; media-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; manifest-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'";

function assertHeader(actual: unknown, location: string): void {
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
  assert.equal(directives.get('trusted-types'), "'none'", `${location}: trusted-types changed`);
  for (const entry of header.split('; ')) {
    const [name, ...sources] = entry.split(' ');
    assert.equal(directives.get(name), sources.join(' '), `${location}: ${name} changed`);
  }
  assert.equal(actual, header, `${location}: Content-Security-Policy changed`);
}

for (const mode of ['production', 'mock']) {
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
    assertHeader(config.server.headers?.['Content-Security-Policy'], `${mode} server`);
    assertHeader(config.preview.headers?.['Content-Security-Policy'], `${mode} preview`);
  });
}

test('the compiled static handler emits the pinned CSP and Trusted Types', async () => {
  const { createAppHandler } = (await import(
    new URL('../.server/server/serve.js', import.meta.url).href
  )) as { createAppHandler: (gateway: unknown) => RequestListener };
  const { createGateway } = (await import(
    new URL('../.server/server/gateway.js', import.meta.url).href
  )) as { createGateway: () => unknown };
  const server = createServer(createAppHandler(createGateway()));
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/baseline-missing-file`);
    await response.arrayBuffer();
    assertHeader(response.headers.get('Content-Security-Policy'), 'static server');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
