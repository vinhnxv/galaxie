// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, chromium, type Page } from 'playwright';
import { build, type Plugin, preview } from 'vite';
import { expect } from 'vitest';
import { cspHeader } from '../../src/host/csp.js';

const configFile = fileURLToPath(new URL('../../vite.config.ts', import.meta.url));

export async function builtHost(plugins: Plugin[] = []): Promise<{
  origin: string;
  open(recipe?: string): Promise<HostPage>;
  close(): Promise<void>;
}> {
  const outDir = await mkdtemp(join(tmpdir(), 'galaxie-recipe-ui-'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let server: Awaited<ReturnType<typeof preview>> | undefined;
  const close = async (): Promise<void> => {
    await browser?.close();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server?.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(outDir, { recursive: true, force: true });
  };
  try {
    await build({
      configFile,
      mode: 'mock',
      logLevel: 'silent',
      plugins,
      build: { outDir, emptyOutDir: true },
    });
    server = await preview({
      configFile,
      mode: 'mock',
      logLevel: 'silent',
      build: { outDir },
      preview: { host: '127.0.0.1', port: 0 },
    });
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('The preview did not start.');
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    return {
      origin,
      async open(recipe = 'financial-js') {
        if (!browser) throw new Error('The browser did not start.');
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const requests: string[] = [];
        const external: string[] = [];
        const errors: string[] = [];
        const violations: string[] = [];
        await context.route('**/*', (route) => {
          const url = route.request().url();
          requests.push(url);
          if (new URL(url).origin === origin) return route.continue();
          external.push(url);
          return route.abort();
        });
        const page = await context.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.exposeFunction('recordPolicyViolation', (directive: string) => {
          violations.push(directive);
        });
        await page.addInitScript(() => {
          Reflect.set(globalThis, 'workerScripts', []);
          const NativeWorker = globalThis.Worker;
          globalThis.Worker = class extends NativeWorker {
            constructor(url: string | URL, options?: WorkerOptions) {
              Reflect.get(globalThis, 'workerScripts').push(String(url));
              super(url, options);
            }
          };
          document.addEventListener('securitypolicyviolation', (event) =>
            Reflect.get(globalThis, 'recordPolicyViolation')(event.effectiveDirective),
          );
        });
        const response = await page.goto(`${origin}/?recipe=${recipe}`);
        expect(response?.headers()['content-security-policy']).toBe(cspHeader());
        return {
          context,
          page,
          requests,
          async verify() {
            expect(external).toEqual([]);
            expect(errors).toEqual([]);
            expect(violations).toEqual([]);
          },
        };
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export interface HostPage {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly requests: readonly string[];
  verify(): Promise<void>;
}

export async function completed(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const status = document.getElementById('run-status')?.textContent;
      return (
        status === 'succeeded' || status === 'failed' || !!document.querySelector('[role="alert"]')
      );
    },
    undefined,
    { timeout: 120000 },
  );
  expect({
    status: await page.locator('#run-status').textContent(),
    alerts: await page.getByRole('alert').allTextContents(),
  }).toEqual({ status: 'succeeded', alerts: [] });
}
