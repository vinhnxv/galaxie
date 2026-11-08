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
import type { FinancialResult, FinancialScenario } from './support/financial.js';
import { assertFinancialScenario } from './support/financial-assertions.js';

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const probe = 'virtual:financial-probe';

test('financial scenarios run in Chromium with the strict policy and only same-origin requests', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'galaxie-financial-'));
  const browser = await chromium.launch({ headless: true });
  let server: Awaited<ReturnType<typeof preview>> | undefined;
  try {
    await build({
      configFile,
      mode: 'mock',
      logLevel: 'silent',
      resolve: {
        alias: {
          '@galaxie-ai/adapter-adk': fileURLToPath(
            new URL('../../../packages/adapter-adk/src/index.ts', import.meta.url),
          ),
        },
      },
      plugins: [
        {
          name: 'financial-probe',
          resolveId(id) {
            return id === probe ? `\0${probe}` : undefined;
          },
          load(id) {
            if (id !== `\0${probe}`) return undefined;
            return `import { runFinancial } from ${JSON.stringify(fileURLToPath(new URL('./support/financial.ts', import.meta.url)))};
            globalThis.runFinancial = runFinancial;`;
          },
        },
      ],
      build: {
        outDir,
        emptyOutDir: true,
        rolldownOptions: { input: probe, output: { entryFileNames: 'probe.js' } },
      },
    });
    await writeFile(
      join(outDir, 'index.html'),
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Financial recipe probe</title><script type="module" src="/probe.js"></script></html>',
    );
    server = await preview({
      configFile,
      mode: 'mock',
      build: { outDir },
      preview: { host: '127.0.0.1', port: 0 },
    });
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('The preview did not start.');
    const origin = `http://127.0.0.1:${address.port}`;
    const page = await browser.newPage();
    const errors: string[] = [];
    const external: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        external.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    await page.addInitScript(() => {
      const violations: string[] = [];
      Reflect.set(globalThis, 'violations', violations);
      document.addEventListener('securitypolicyviolation', (event) =>
        violations.push(event.violatedDirective),
      );
    });
    const response = await page.goto(origin);
    expect(response?.headers()['content-security-policy']).toBe(cspHeader());
    await page.waitForFunction(() => typeof Reflect.get(globalThis, 'runFinancial') === 'function');
    for (const scenario of ['normal', 'empty', 'blocked', 'budget', 'injection'] as const) {
      const result = await page.evaluate(async (scenario) => {
        const run = Reflect.get(globalThis, 'runFinancial') as (
          scenario: FinancialScenario,
        ) => Promise<FinancialResult>;
        return run(scenario);
      }, scenario);
      assertFinancialScenario(scenario, result);
    }
    expect(await page.evaluate(() => Reflect.get(globalThis, 'violations'))).toEqual([]);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  } finally {
    await browser.close();
    if (server)
      await new Promise<void>((resolve, reject) =>
        server?.httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    await rm(outDir, { recursive: true, force: true });
  }
}, 30000);
