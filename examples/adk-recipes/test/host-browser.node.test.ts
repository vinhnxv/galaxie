// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeAll, expect, test } from 'vitest';
import { goAvailable, missingGo } from '../../rag-browser/test/support/go-gate.node.js';
import { LEGAL_DISCLAIMER } from '../src/host/disclaimer.js';
import { builtHost, completed } from './support/host-browser.node.js';

let host: Awaited<ReturnType<typeof builtHost>>;
beforeAll(async () => {
  host = await builtHost();
}, 120000);
afterAll(async () => {
  await host?.close();
});

test('the picker runs the JavaScript financial recipe with its disclaimer above checked text', async () => {
  const probe = await host.open();
  const { page } = probe;
  try {
    await expect.poll(() => page.getByLabel('Recipe').count(), { timeout: 2000 }).toBe(1);
    expect(await page.getByLabel('Recipe').inputValue()).toBe('financial-js');
    expect(await page.locator('#disclaimer').textContent()).toBe(LEGAL_DISCLAIMER);
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await completed(page);
    expect(await page.locator('#output').textContent()).toContain('Risk assessment:');
    expect(await page.locator('#output').textContent()).toContain(LEGAL_DISCLAIMER);
    expect(await page.getByRole('list', { name: 'Model destinations' }).textContent()).toContain(
      'In browser',
    );
    expect(
      await page.evaluate(() => {
        const disclaimer = document.getElementById('disclaimer');
        const output = document.getElementById('output');
        return (
          !!disclaimer &&
          !!output &&
          !!(disclaimer.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }),
    ).toBe(true);
    expect(probe.requests.some((url) => /\/python\/|\/go\//.test(url))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(globalThis, 'workerScripts'))).toEqual([]);
    await probe.verify();
  } finally {
    await probe.context.close();
  }
}, 30000);

test('a question outside the scripted fixtures reports unverifiable without starting a runtime', async () => {
  const probe = await host.open();
  const { page } = probe;
  try {
    await page.getByLabel('Question').fill('What is the real share price today?');
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect.poll(() => page.locator('#output').textContent()).toContain('Unverifiable');
    expect(await page.locator('#run-status').textContent()).toContain('idle');
    expect(await page.evaluate(() => Reflect.get(globalThis, 'workerScripts'))).toEqual([]);
    await probe.verify();
  } finally {
    await probe.context.close();
  }
}, 30000);

test('the page never displays a streamed reply blocked by the host output-safety hook', async () => {
  const blocked = await builtHost([
    {
      name: 'blocked-financial-reply',
      enforce: 'pre',
      transform(code, id) {
        if (!id.endsWith('/src/host/recipe-host.ts')) return;
        return code.replace(
          /outputSafety:\s*\(\)\s*=>\s*['"]allow['"]/,
          "outputSafety: ({ text }) => text.includes('Risk assessment:') ? 'block' : 'allow'",
        );
      },
    },
  ]);
  const probe = await blocked.open();
  const { page } = probe;
  try {
    await page.getByRole('button', { name: 'Run', exact: true }).click();
    await expect
      .poll(() => page.locator('#run-status').textContent(), { timeout: 30000 })
      .toContain('failed');
    expect(await page.locator('#output').textContent()).not.toContain('Risk assessment:');
    expect(await page.getByRole('alert').textContent()).not.toContain('No model is available');
    await probe.verify();
  } finally {
    await probe.context.close();
    await blocked.close();
  }
}, 120000);

test.skipIf(!goAvailable)(
  goAvailable ? 'the picker runs the Go financial recipe with the same fixture result' : missingGo,
  async () => {
    const probe = await host.open();
    const { page } = probe;
    try {
      await page.getByLabel('Recipe').selectOption('financial-go');
      await page.waitForURL('**/?recipe=financial-go');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await completed(page);
      expect(await page.locator('#output').textContent()).toContain('Risk assessment:');
      expect(await page.locator('#output').textContent()).toContain(LEGAL_DISCLAIMER);
      expect(probe.requests.some((url) => url.includes('/go/financial.wasm'))).toBe(true);
      expect(probe.requests.some((url) => url.includes('/python/'))).toBe(false);
      expect(await page.evaluate(() => Reflect.get(globalThis, 'workerScripts').length)).toBe(1);
      await probe.verify();
    } finally {
      await probe.context.close();
    }
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'switching recipes aborts the running model before the next page starts'
    : missingGo,
  async () => {
    const delayed = await builtHost([
      {
        name: 'financial-abort-observation',
        enforce: 'pre',
        transform(code, id) {
          if (!id.endsWith('/src/recipes/financial/script.ts')) return;
          return code.replace(
            /id:\s*['"]search['"],/,
            `id: 'search',
        wait: {
          entered: Promise.resolve(),
          release() {},
          async wait(signal) {
            if (sessionStorage.getItem('model-aborted') === 'yes') return;
            sessionStorage.setItem('model-waiting', 'yes');
            await new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => {
                sessionStorage.setItem('model-aborted', 'yes');
                reject(signal.reason);
              }, { once: true });
            });
          },
        },`,
          );
        },
      },
    ]);
    const probe = await delayed.open();
    const { page } = probe;
    try {
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await page.waitForFunction(() => sessionStorage.getItem('model-waiting') === 'yes');
      await page.getByLabel('Recipe').selectOption('financial-go');
      await page.waitForURL('**/?recipe=financial-go');
      expect(await page.evaluate(() => sessionStorage.getItem('model-aborted'))).toBe('yes');
      expect(await page.locator('#run-status').textContent()).toContain('idle');
      expect(probe.requests.some((url) => url.includes('/go/financial.wasm'))).toBe(false);
      expect(await page.evaluate(() => Reflect.get(globalThis, 'workerScripts'))).toEqual([]);
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await completed(page);
      await probe.verify();
    } finally {
      await probe.context.close();
      await delayed.close();
    }
  },
  120000,
);
