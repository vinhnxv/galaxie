// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
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
    // The client drops the system role before the gateway sees it, so the request alone cannot show
    // that a system prompt is set. Assert the agent sets one, then that the answer still arrives.
    const graph = await readFile(
      join(fixture.directory, 'python/agent/starter_agent/graph.py'),
      'utf8',
    );
    expect(graph).toMatch(/SystemMessage\(\s*content="[^"]+"/);
    expect(graph).toMatch(/model\.ainvoke\(\[\s*SystemMessage\(/);
    const graphPath = '/python/agent/starter_agent/graph.py';
    const graphBytes = await readFile(join(built.directory, graphPath));
    const releaseGraph = Promise.withResolvers<void>();
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
        plugins: [
          {
            name: 'delay-python-agent-source',
            configurePreviewServer({ middlewares }) {
              middlewares.use(graphPath, (_request, response) => {
                response.writeHead(200, {
                  'Cache-Control': 'no-store',
                  'Content-Security-Policy': cspHeader(),
                  'Content-Type': 'application/octet-stream',
                });
                response.write(graphBytes);
                void releaseGraph.promise.then(() => response.end());
              });
            },
          },
          gatewayPlugin(devGatewayOptions()),
        ],
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
      await context.addInitScript((delayedPath) => {
        Reflect.set(globalThis, 'starterViolations', []);
        document.addEventListener('securitypolicyviolation', (event) =>
          Reflect.get(globalThis, 'starterViolations').push(event.violatedDirective),
        );
        const sourceSignals: (AbortSignal | null | undefined)[] = [];
        Reflect.set(globalThis, 'starterSourceSignals', sourceSignals);
        const fetcher = globalThis.fetch;
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          if (!url.includes('/python/agent/')) return fetcher(input, init);
          sourceSignals.push(init?.signal);
          const response = await fetcher(input, init);
          if (url.endsWith(delayedPath) && response.body !== null) {
            const getReader = response.body.getReader.bind(response.body);
            let bytesRead = 0;
            Object.defineProperty(response.body, 'getReader', {
              value: () => {
                const reader = getReader();
                const read = reader.read.bind(reader);
                reader.read = async () => {
                  const chunk = await read();
                  if (!chunk.done) {
                    bytesRead += chunk.value.byteLength;
                    Reflect.set(globalThis, 'starterGraphBytesRead', bytesRead);
                  }
                  return chunk;
                };
                return reader;
              },
            });
          }
          return response;
        };
      }, graphPath);
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
      await Promise.all([
        page.waitForFunction(
          (size) => Reflect.get(globalThis, 'starterGraphBytesRead') === size,
          graphBytes.byteLength,
        ),
        page.waitForEvent(
          'requestfinished',
          (request) =>
            new URL(request.url()).pathname === '/python/agent/starter_agent/__init__.py',
        ),
        page.getByRole('button', { name: 'Start with gateway', exact: true }).click(),
      ]);
      // Deliver EOF in its own write after Chromium has consumed the last bytes.
      releaseGraph.resolve();
      await page.getByRole('radio', { name: '4', exact: true }).check();
      const aborted = await page.evaluate(() => {
        const signals: (AbortSignal | null | undefined)[] = Reflect.get(
          globalThis,
          'starterSourceSignals',
        );
        return signals.map((signal) => signal?.aborted);
      });
      // Every source download signal stays live after its body has been fully read.
      expect(aborted.length).toBeGreaterThanOrEqual(1);
      expect(aborted.every((value) => value === false)).toBe(true);
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
      releaseGraph.resolve();
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
