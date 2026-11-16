// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { basename, dirname, resolve } from 'node:path';
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

function imports(source: string): string[] {
  return [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)].map(
    (match) => match[1] ?? '',
  );
}

function assertProductionFile(path: string): void {
  assert.doesNotMatch(
    basename(path),
    /^(?:mock-upstream|dev)(?:\.|$)/,
    `Production reaches ${basename(path)}`,
  );
}

test('the production entry cannot reach dev or mock-upstream source', async () => {
  const visited = new Set<string>();
  async function visit(path: string): Promise<void> {
    assertProductionFile(path);
    if (visited.has(path)) return;
    visited.add(path);
    for (const specifier of imports(await readFile(path, 'utf8'))) {
      if (specifier.startsWith('.'))
        await visit(resolve(dirname(path), specifier.replace(/\.js$/, '.ts')));
    }
  }
  await visit(fileURLToPath(new URL('../server/serve.ts', import.meta.url)));
});

test('the compiled server contains no dev or mock-upstream files or imports', async () => {
  const directory = fileURLToPath(new URL('../.server/', import.meta.url));
  for (const entry of await readdir(directory, { recursive: true })) {
    assertProductionFile(entry);
    if (!entry.endsWith('.js')) continue;
    for (const specifier of imports(await readFile(resolve(directory, entry), 'utf8')))
      assertProductionFile(specifier);
  }
});

test('the compiled production handler stays unavailable without an upstream', async () => {
  const previous = [process.env['UPSTREAM_BASE_URL'], process.env['UPSTREAM_API_KEY']];
  delete process.env['UPSTREAM_BASE_URL'];
  delete process.env['UPSTREAM_API_KEY'];
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const { createAppHandler, gatewayOptionsFromEnvironment } = (await import(
      new URL('../.server/server/serve.js', import.meta.url).href
    )) as {
      createAppHandler: (gateway: unknown) => RequestListener;
      gatewayOptionsFromEnvironment: () => unknown;
    };
    const { createGateway } = (await import(
      new URL('../.server/server/gateway.js', import.meta.url).href
    )) as { createGateway: (options: unknown) => unknown };
    server = createServer(createAppHandler(createGateway(gatewayOptionsFromEnvironment())));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const session = await fetch(`${origin}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'demo-ada' }),
    });
    assert.equal(session.status, 200);
    const credential = (await session.json()) as { token: string };
    assert.equal(typeof credential.token, 'string');
    const response = await fetch(`${origin}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${credential.token}`,
      },
      body: JSON.stringify({
        model: 'gateway-comment',
        messages: [{ role: 'user', content: 'A practice comment, please.' }],
        metadata: { promptId: 'practice-comment', variables: { tone: 'encouraging' } },
      }),
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('x-galaxie-upstream'), null);
    assert.deepEqual(await response.json(), { error: 'unavailable' });
  } finally {
    for (const [index, name] of ['UPSTREAM_BASE_URL', 'UPSTREAM_API_KEY'].entries()) {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (server !== undefined) {
      const running = server;
      await new Promise<void>((resolve, reject) => {
        running.close((error) => (error ? reject(error) : resolve()));
        running.closeAllConnections();
      });
    }
  }
});
