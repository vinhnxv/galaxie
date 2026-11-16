// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { afterAll, describe, expect, test } from 'vitest';
import { devGatewayOptions } from '../../packages/create/.cache/composed/gateway-langgraph-python/server/dev.js';
import { createGateway } from '../../packages/create/.cache/composed/gateway-langgraph-python/server/gateway.js';
import { gatewayPlugin } from '../../packages/create/.cache/composed/gateway-langgraph-python/server/plugin.js';
import { createAppHandler } from '../../packages/create/.cache/composed/gateway-langgraph-python/server/serve.js';
import { cspHeader } from '../../packages/create/.cache/composed/gateway-langgraph-python/src/csp.js';
import {
  buildProject,
  cleanStarterDist,
  hasStarterPython,
  starterProject,
} from './support/starter-python.node.js';

afterAll(cleanStarterDist);

describe.skipIf(!hasStarterPython())('the composed LangGraph Python gateway starter', () => {
  test('answers through preview with an agent system prompt and no Python; production stays unavailable', async () => {
    const fixture = await starterProject('gateway');
    const built = await buildProject(fixture, 'built');
    expect(built.status, built.output).toBe(0);
    const previous = {
      PATH: process.env['PATH'],
      UPSTREAM_BASE_URL: process.env['UPSTREAM_BASE_URL'],
      UPSTREAM_API_KEY: process.env['UPSTREAM_API_KEY'],
    };
    let server: Awaited<ReturnType<typeof preview>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    const production = createServer(createAppHandler(createGateway(), built.directory));
    try {
      process.env['PATH'] = fixture.noPython;
      delete process.env['UPSTREAM_BASE_URL'];
      delete process.env['UPSTREAM_API_KEY'];
      for (const command of ['python', 'python3', 'uv'])
        expect(spawnSync(command, ['--version']).error).toMatchObject({ code: 'ENOENT' });
      server = await preview({
        configFile: false,
        logLevel: 'silent',
        plugins: [gatewayPlugin(devGatewayOptions())],
        build: { outDir: built.directory },
        preview: {
          host: '127.0.0.1',
          port: 0,
          strictPort: true,
          headers: { 'Content-Security-Policy': cspHeader() },
        },
      });
      const address = server.httpServer.address();
      if (address === null || typeof address === 'string')
        throw new Error('The preview has no TCP port.');
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({
        headless: true,
        args: ['--disable-gpu', '--disable-webgpu'],
      });
      const context = await browser.newContext({ serviceWorkers: 'block' });
      await context.addInitScript(() => {
        Reflect.set(globalThis, 'starterViolations', []);
        document.addEventListener('securitypolicyviolation', (event) =>
          Reflect.get(globalThis, 'starterViolations').push(event.violatedDirective),
        );
      });
      const requests: { messages: { role: string }[]; metadata: { promptId: string } }[] = [];
      const external: string[] = [];
      const errors: string[] = [];
      const workerHeaders: string[] = [];
      context.on('response', (response) => {
        if (response.status() >= 400) errors.push(`${response.url()}: HTTP ${response.status()}`);
        if (/pyodide-worker.*\.js/.test(response.url()))
          workerHeaders.push(response.headers()['content-security-policy'] ?? '');
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          external.push(url.href);
          return route.abort();
        }
        if (url.pathname === '/api/v1/chat/completions')
          requests.push(route.request().postDataJSON());
        return route.continue();
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('requestfailed', (request) =>
        errors.push(request.failure()?.errorText ?? 'Request failed.'),
      );
      expect((await page.goto(origin))?.headers()['content-security-policy']).toBe(cspHeader());
      await page.getByRole('button', { name: 'Start with gateway', exact: true }).click();
      await page.getByRole('radio', { name: '4', exact: true }).check();
      await page.getByRole('button', { name: 'Submit answers', exact: true }).click();
      await page
        .getByText('Correct. This is a fixed reply from the mock upstream.', { exact: true })
        .waitFor();
      await page
        .getByText('Replies are fixed sample text from a mock upstream.', { exact: true })
        .waitFor();
      expect(requests).toHaveLength(1);
      expect(requests[0]?.messages.map((message) => message.role)).toEqual(['user']);
      expect(requests[0]?.metadata.promptId).toBe('practice-comment');
      expect(workerHeaders).toEqual([cspHeader()]);
      expect(await page.evaluate(() => Reflect.get(globalThis, 'starterViolations'))).toEqual([]);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
      await context.close();
      await new Promise<void>((done) => production.listen(0, '127.0.0.1', done));
      const productionAddress = production.address();
      if (productionAddress === null || typeof productionAddress === 'string')
        throw new Error('The production server has no TCP port.');
      const productionOrigin = `http://127.0.0.1:${productionAddress.port}`;
      const session = await fetch(`${productionOrigin}/api/session`, {
        method: 'POST',
        body: JSON.stringify({ userId: 'demo-ada' }),
      });
      expect(session.status).toBe(200);
      const { token } = (await session.json()) as { token: string };
      const response = await fetch(`${productionOrigin}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gateway-comment',
          messages: [{ role: 'user', content: 'A practice comment, please.' }],
          metadata: { promptId: 'practice-comment', variables: { tone: 'encouraging' } },
        }),
      });
      expect(response.status).toBe(503);
      expect(response.headers.get('x-galaxie-upstream')).toBeNull();
      await response.body?.cancel();
    } finally {
      await browser?.close();
      if (server !== undefined) {
        const listener = server.httpServer;
        await new Promise<void>((done, reject) => {
          listener.close((error) => (error ? reject(error) : done()));
          if ('closeAllConnections' in listener) listener.closeAllConnections();
        });
      }
      if (production.listening)
        await new Promise<void>((done, reject) => {
          production.close((error) => (error ? reject(error) : done()));
          production.closeAllConnections();
        });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 180_000);
});
