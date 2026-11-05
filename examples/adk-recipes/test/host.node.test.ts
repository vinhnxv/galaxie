// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { expect, test } from 'vitest';
import { cspHeader } from '../src/host/csp.js';
import { LEGAL_DISCLAIMER } from '../src/host/disclaimer.js';

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));

test.each(['mock', 'production'])(
  'built %s page keeps the strict CSP and makes only same-origin requests',
  async (mode) => {
    const outDir = await mkdtemp(join(tmpdir(), 'galaxie-recipe-host-'));
    const browser = await chromium.launch({ headless: true });
    let server: Awaited<ReturnType<typeof preview>> | undefined;
    try {
      await build({ configFile, mode, logLevel: 'silent', build: { outDir, emptyOutDir: true } });
      server = await preview({
        configFile,
        mode,
        build: { outDir },
        preview: { host: '127.0.0.1', port: 0 },
      });
      const address = server.httpServer.address();
      if (address === null || typeof address === 'string')
        throw new Error('The preview did not start.');
      const origin = `http://127.0.0.1:${address.port}`;
      const page = await browser.newPage();
      const errors: string[] = [];
      const external: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => {
        if (new URL(route.request().url()).origin !== origin) {
          external.push('external-request');
          return route.abort();
        }
        return route.continue();
      });
      await page.addInitScript(() => {
        const scope = globalThis as typeof globalThis & { violations: string[] };
        scope.violations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
          scope.violations.push(event.violatedDirective),
        );
      });
      const response = await page.goto(origin);
      expect(response?.headers()['content-security-policy']).toBe(cspHeader());
      await expect
        .poll(() => page.locator('#providers').textContent())
        .toContain(mode === 'mock' ? 'deterministic mock' : 'No model provider is configured');
      expect(await page.locator('#assets').textContent()).toMatch(
        /^Python recipe assets: (?:available|unavailable)\. Go recipe assets: (?:available|unavailable)\.$/,
      );
      expect(await page.locator('#disclaimer').textContent()).toBe(LEGAL_DISCLAIMER);
      expect(await page.getByRole('button').count()).toBe(0);
      await page.getByText('Upstream financial disclaimer', { exact: true }).click();
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
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
  },
  30000,
);
