// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { expect, test } from 'vitest';
import { goInstalled } from '../../../scripts/go-wasm-lock.ts';
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
        // Test even the default bundle under the original same-origin-only policy.
        preview: {
          host: '127.0.0.1',
          port: 0,
          headers: { 'Content-Security-Policy': cspHeader() },
        },
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
        // Never probe a real GPU or permit a real model download in this host test.
        Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
        const scope = globalThis as typeof globalThis & { violations: string[] };
        scope.violations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
          scope.violations.push(
            JSON.stringify({
              directive: event.violatedDirective,
              source: event.sourceFile,
              line: event.lineNumber,
              sample: event.sample,
            }),
          ),
        );
      });
      const response = await page.goto(origin);
      expect(response?.headers()['content-security-policy']).toBe(cspHeader());
      await expect
        .poll(() => page.locator('#providers').textContent())
        .toContain(mode === 'mock' ? 'deterministic mock' : 'Local ONNX: Qwen3.5-0.8B');
      expect(await page.locator('#assets').textContent()).toMatch(
        /^Python recipe assets: (?:available|unavailable)\. Go recipe assets: (?:available|unavailable)\.$/,
      );
      expect(await page.locator('#assets').textContent()).toContain(
        `Go recipe assets: ${goInstalled() ? 'available' : 'unavailable'}.`,
      );
      expect(await page.locator('#disclaimer').textContent()).toBe(LEGAL_DISCLAIMER);
      expect(await page.getByLabel('Recipe').count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Run', exact: true }).isEnabled()).toBe(true);
      expect(await page.locator('#disclaimer').isVisible()).toBe(true);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
      if (mode !== 'mock') {
        await page.getByRole('button', { name: 'Run', exact: true }).click();
        await expect.poll(() => page.locator('#run-status').textContent()).toBe('failed');
        expect(await page.getByRole('alert').textContent()).toContain('No model is available');
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
