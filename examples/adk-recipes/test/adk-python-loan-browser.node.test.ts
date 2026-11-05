// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { expect, test } from 'vitest';
import { cspHeader } from '../src/host/csp.js';
import type { LoanBrowserResult } from './support/loan-browser.js';
import { missingPythonWheels, pythonWheelsAvailable } from './support/python.node.js';

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const probe = 'virtual:loan-probe';

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'Chromium reload restores a loan approval from IndexedDB under strict CSP'
    : missingPythonWheels,
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'galaxie-loan-python-'));
    let server: Awaited<ReturnType<typeof preview>> | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      await build({
        configFile,
        mode: 'mock',
        logLevel: 'silent',
        plugins: [
          {
            name: 'loan-probe',
            resolveId(id) {
              return id === probe ? `\0${probe}` : undefined;
            },
            load(id) {
              return id === `\0${probe}`
                ? `import ${JSON.stringify(fileURLToPath(new URL('./support/loan-browser.ts', import.meta.url)))};`
                : undefined;
            },
          },
        ],
        build: {
          outDir: directory,
          emptyOutDir: true,
          rolldownOptions: { input: probe, output: { entryFileNames: 'probe.js' } },
        },
      });
      await writeFile(
        join(directory, 'index.html'),
        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Loan recipe probe</title><script type="module" src="/probe.js"></script></html>',
      );
      server = await preview({
        configFile,
        mode: 'mock',
        logLevel: 'silent',
        build: { outDir: directory },
        preview: { host: '127.0.0.1', port: 0 },
      });
      const address = server.httpServer.address();
      if (!address || typeof address === 'string')
        throw new Error('The loan preview did not start.');
      const origin = `http://127.0.0.1:${address.port}`;
      browser = await chromium.launch({ headless: true });
      for (const action of ['approve', 'deny'] as const) {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const external: string[] = [];
        const errors: string[] = [];
        const requests: string[] = [];
        try {
          await context.route('**/*', (route) => {
            const url = route.request().url();
            requests.push(url);
            if (new URL(url).origin === origin) return route.continue();
            external.push(url);
            return route.abort();
          });
          const page = await context.newPage();
          page.on('pageerror', (error) => errors.push(error.message));
          await page.addInitScript(() => {
            Reflect.set(globalThis, 'violations', []);
            document.addEventListener('securitypolicyviolation', (event) =>
              Reflect.get(globalThis, 'violations').push({
                directive: event.effectiveDirective,
                sample: event.sample,
                source: event.sourceFile,
                line: event.lineNumber,
              }),
            );
          });
          const response = await page.goto(origin);
          expect(response?.headers()['content-security-policy']).toBe(cspHeader());
          await page.waitForFunction(() => !!Reflect.get(globalThis, 'loanProbe'));
          const first: LoanBrowserResult = await page.evaluate(() =>
            Reflect.get(globalThis, 'loanProbe').start(),
          );
          expect(first.observation.error).toBeUndefined();
          expect(first.observation.pending).toBeDefined();
          expect(first.decisions).toBe(0);
          expect(await page.evaluate(() => Reflect.get(globalThis, 'violations'))).toEqual([]);
          await page.evaluate(() => Reflect.get(globalThis, 'loanProbe').close());
          await page.reload();
          await page.waitForFunction(() => !!Reflect.get(globalThis, 'loanProbe'));
          const restored: LoanBrowserResult = await page.evaluate(() =>
            Reflect.get(globalThis, 'loanProbe').start(),
          );
          expect(restored.sessionId).toBe(first.sessionId);
          expect(restored.observation.pending).toEqual(first.observation.pending);
          expect(restored.calls).toEqual([]);
          expect(restored.outcome).toMatchObject({
            status: 'pending',
            summary: { company: 'Lantern Orchard Workshop', annualRevenue: 180000 },
          });
          const completed: LoanBrowserResult = await page.evaluate(
            (action) => Reflect.get(globalThis, 'loanProbe').answer(action),
            action,
          );
          expect(completed.observation.status).toBe('succeeded');
          expect(completed.observation.error).toBeUndefined();
          expect(completed.decisions).toBe(action === 'approve' ? 1 : 0);
          expect(completed.calls).toEqual(action === 'approve' ? ['loan.finalize@1'] : []);
          expect(completed.outcome.status).toBe(action === 'approve' ? 'finalized' : 'undecided');
          expect(requests.some((url) => url.includes('/python/runtime/pyodide.mjs'))).toBe(true);
          expect(requests.some((url) => url.includes('/python/agent/loan/agent.py'))).toBe(true);
          expect(external).toEqual([]);
          expect(errors).toEqual([]);
          expect(await page.evaluate(() => Reflect.get(globalThis, 'violations'))).toEqual([]);
          await page.evaluate(() => Reflect.get(globalThis, 'loanProbe').close());
        } finally {
          await context.close();
        }
      }
    } finally {
      await browser?.close();
      if (server)
        await new Promise<void>((resolve, reject) =>
          server?.httpServer.close((error) => (error ? reject(error) : resolve())),
        );
      await rm(directory, { recursive: true, force: true });
    }
  },
  240000,
);
