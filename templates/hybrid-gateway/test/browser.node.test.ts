// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, createServer as createViteServer, preview } from 'vite';
import { expect, it } from 'vitest';
import { gatewayPlugin } from '../server/plugin.js';
import { createAppHandler } from '../server/serve.js';
import { cspHeader } from '../src/csp.js';
import { harness, listen } from './support.node.js';

const template = fileURLToPath(new URL('..', import.meta.url));

async function files(directory: string): Promise<string[]> {
  return (
    await Promise.all(
      (
        await readdir(directory, { withFileTypes: true })
      )
        .filter(
          (entry) =>
            !['node_modules', 'dist', '.server'].includes(entry.name) &&
            !entry.name.startsWith('.browser-check-'),
        )
        .map((entry) =>
          entry.isDirectory()
            ? files(join(directory, entry.name))
            : Promise.resolve([join(directory, entry.name)]),
        ),
    )
  ).flat();
}

it('builds and completes the browser agent under CSP with same-origin traffic and no credential residue', async () => {
  const server = await harness();
  const directory = await mkdtemp(join(template, '.browser-check-'));
  const workspace = JSON.parse(
    await readFile(new URL('../tsconfig.workspace.json', import.meta.url), 'utf8'),
  ) as { compilerOptions: { paths: Record<string, string[]> } };
  const alias = Object.entries(workspace.compilerOptions.paths)
    .filter(([name]) => name.startsWith('@galaxie/'))
    .sort(([a], [b]) => b.length - a.length)
    .map(([find, paths]) => {
      const path = paths[0];
      if (path === undefined) throw new Error('Missing workspace source mapping.');
      return { find, replacement: fileURLToPath(new URL(path, new URL('../', import.meta.url))) };
    });
  const previous = process.env['NODE_ENV'];
  const previousKey = process.env['UPSTREAM_API_KEY'];
  const previousBase = process.env['UPSTREAM_BASE_URL'];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    process.env['NODE_ENV'] = 'production';
    process.env['UPSTREAM_API_KEY'] = server.apiKey;
    process.env['UPSTREAM_BASE_URL'] = `${server.upstreamOrigin}/v1`;
    await build({
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      logLevel: 'silent',
      resolve: { alias },
      build: { outDir: directory, emptyOutDir: true },
    });
    const origin = await listen(createServer(createAppHandler(server.gateway, directory)));
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const urls: string[] = [];
    const errors: string[] = [];
    const apiBodies: string[] = [];
    const issued: string[] = [];
    await context.route('**/*', async (route) => {
      urls.push(route.request().url());
      const target = new URL(route.request().url());
      if (target.origin !== origin) await route.abort('blockedbyclient');
      else if (target.pathname.startsWith('/api/')) {
        // Read API bodies here: the browser cannot return a streamed body after the page consumed it.
        const fetched = await route.fetch();
        const text = await fetched.text();
        // The session body delivers the token by design; every other body must not contain it.
        if (target.pathname === '/api/session')
          issued.push((JSON.parse(text) as { token: string }).token);
        else apiBodies.push(text);
        await route.fulfill({ response: fetched, body: text });
      } else await route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    const response = await page.goto(origin);
    expect(response?.headers()['content-security-policy']).toBe(cspHeader());
    await page.getByRole('button', { name: 'Start with gateway', exact: true }).click();
    await page.getByRole('radio', { name: '4', exact: true }).check();
    await page.getByRole('button', { name: 'Submit answers', exact: true }).click();
    await page.getByText('Correct. Keep practicing.', { exact: true }).waitFor();
    expect(await page.getByRole('list', { name: 'Model destinations' }).textContent()).toContain(
      'Comment: Gateway (Host server)',
    );
    const storage = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
      dom: document.documentElement.outerHTML,
    }));
    const bodies = apiBodies;
    expect(issued).toHaveLength(1);
    const canaries = [server.apiKey, ...issued];
    for (const canary of canaries) {
      expect(JSON.stringify({ urls, errors, storage, bodies })).not.toContain(canary);
      // Scan the actual build recursively, including binary assets as bytes.
      for (const file of await files(directory)) {
        expect((await readFile(file)).includes(Buffer.from(canary))).toBe(false);
      }
      // Runtime-generated canaries cannot be accidentally baked into source or configuration.
      for (const file of await files(template)) {
        expect((await readFile(file)).includes(Buffer.from(canary))).toBe(false);
      }
    }
    expect(storage.local).toEqual({});
    expect(storage.session).toEqual({});
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => new URL(url).origin === origin)).toBe(true);
    // Zod probes eval support once with `new Function('')`. The CSP blocks that caught probe, which
    // logs this one message and falls back to schemas without code generation. Nothing else may log.
    const evalProbe = "This document requires 'TrustedScript' assignment.";
    expect(errors.filter((message) => !message.startsWith(evalProbe))).toEqual([]);
    expect(errors.filter((message) => message.startsWith(evalProbe)).length).toBeLessThanOrEqual(1);
    expect(server.records).toHaveLength(1);
    await context.close();
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
    for (const [name, value] of [
      ['NODE_ENV', previous],
      ['UPSTREAM_API_KEY', previousKey],
      ['UPSTREAM_BASE_URL', previousBase],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}, 60_000);

it('mounts the same gateway on Vite dev and preview', async () => {
  const upstream = await harness();
  const directory = await mkdtemp(join(template, '.browser-check-'));
  const options = {
    upstream: { baseURL: `${upstream.upstreamOrigin}/v1`, apiKey: upstream.apiKey },
  };
  const dev = await createViteServer({
    configFile: false,
    plugins: [gatewayPlugin(options)],
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0 },
  });
  let built: Awaited<ReturnType<typeof preview>> | undefined;
  try {
    built = await preview({
      configFile: false,
      plugins: [gatewayPlugin(options)],
      logLevel: 'silent',
      build: { outDir: directory },
      preview: { host: '127.0.0.1', port: 0, strictPort: true },
    });
    await dev.listen();
    for (const listener of [dev.httpServer, built.httpServer]) {
      const address = listener?.address();
      if (address === undefined || address === null || typeof address === 'string') {
        throw new Error('Missing Vite port.');
      }
      const origin = `http://127.0.0.1:${address.port}`;
      expect((await fetch(`${origin}/api/notes`, { method: 'POST' })).status).toBe(401);
      const session = await fetch(`${origin}/api/session`, {
        method: 'POST',
        body: JSON.stringify({ userId: 'demo-ada' }),
      });
      expect(session.status).toBe(200);
      expect(session.headers.get('cache-control')).toBe('no-store');
    }
  } finally {
    await dev.close();
    if (built !== undefined) {
      const current = built;
      await new Promise<void>((resolve, reject) => {
        current.httpServer.close((error) => (error ? reject(error) : resolve()));
        if ('closeAllConnections' in current.httpServer) current.httpServer.closeAllConnections();
      });
    }
    await rm(directory, { recursive: true, force: true });
  }
});
