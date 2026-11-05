// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { AUDITOR_REVISED_ANSWER } from '../src/recipes/llm-auditor/script.js';
import { builtHost, completed } from './support/host-browser.node.js';
import { missingPythonWheels, pythonWheelsAvailable } from './support/python.node.js';

let host: Awaited<ReturnType<typeof builtHost>>;
beforeAll(async () => {
  if (pythonWheelsAvailable) host = await builtHost();
}, 120000);
afterAll(async () => {
  await host?.close();
});

async function approval(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      !!document.querySelector('[role="alert"]') ||
      [...document.querySelectorAll('button')].some((button) => button.textContent === 'Approve'),
    undefined,
    { timeout: 120000 },
  );
  expect({
    buttons: await page.getByRole('button', { name: 'Approve', exact: true }).count(),
    alerts: await page.getByRole('alert').allTextContents(),
  }).toEqual({ buttons: 1, alerts: [] });
}

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'the picker runs the Python auditor with verified local wheels'
    : missingPythonWheels,
  async () => {
    const probe = await host.open();
    const { page } = probe;
    try {
      await page.getByLabel('Recipe').selectOption('llm-auditor');
      await page.waitForURL('**/?recipe=llm-auditor');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await completed(page);
      expect(await page.locator('#output').textContent()).toContain(AUDITOR_REVISED_ANSWER);
      expect(await page.getByRole('list', { name: 'Model destinations' }).textContent()).toContain(
        'In browser',
      );
      expect(probe.requests.some((url) => url.includes('/python/runtime/pyodide.mjs'))).toBe(true);
      expect(probe.requests.some((url) => url.includes('/go/financial.wasm'))).toBe(false);
      expect(await page.evaluate(() => Reflect.get(globalThis, 'workerScripts').length)).toBe(1);
      await probe.verify();
    } finally {
      await probe.context.close();
    }
  },
  180000,
);

test.skipIf(!pythonWheelsAvailable).each(['approve', 'deny'] as const)(
  pythonWheelsAvailable
    ? 'the loan page restores its pause, accepts %s and clears on Start over'
    : missingPythonWheels,
  async (action) => {
    const probe = await host.open();
    const { page } = probe;
    try {
      await page.getByLabel('Recipe').selectOption('loan');
      await page.waitForURL('**/?recipe=loan');
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await approval(page);
      const pending = await page.locator('#loan-outcome').textContent();
      expect(pending).toContain('Pending decision: approved');
      expect(await page.getByText('Lantern Orchard Workshop').count()).toBeGreaterThan(0);
      const session = await page.evaluate(() => ({ ...sessionStorage }));
      const sessionId = await page.evaluate(() =>
        sessionStorage.getItem('galaxie:adk-recipes:demo:loan'),
      );
      expect(sessionId).toBeTruthy();
      if (action === 'approve') {
        await page.getByLabel('Recipe').selectOption('financial-js');
        await page.waitForURL('**/?recipe=financial-js');
        await Promise.all([
          page.waitForEvent('domcontentloaded'),
          page.getByRole('button', { name: 'Start over', exact: true }).click(),
        ]);
        expect(
          await page.evaluate(() => sessionStorage.getItem('galaxie:adk-recipes:demo:loan')),
        ).toBe(sessionId);
        await page.getByLabel('Recipe').selectOption('loan');
        await page.waitForURL('**/?recipe=loan');
        await approval(page);
        expect(await page.locator('#loan-outcome').textContent()).toBe(pending);
      }
      await page.reload();
      await approval(page);
      expect(await page.locator('#loan-outcome').textContent()).toBe(pending);
      expect(await page.evaluate(() => ({ ...sessionStorage }))).toEqual(session);
      await page
        .getByRole('button', { name: action === 'approve' ? 'Approve' : 'Deny', exact: true })
        .click();
      if (action === 'approve')
        await page.getByRole('button', { name: 'Finalize', exact: true }).click();
      await completed(page);
      expect(await page.locator('#loan-outcome').textContent()).toContain(
        action === 'approve' ? 'Finalized decision: approved' : 'Undecided',
      );
      await probe.verify();
      await page.getByRole('button', { name: 'Start over', exact: true }).click();
      await expect.poll(() => page.locator('#run-status').textContent()).toContain('idle');
      expect(await page.locator('#loan-outcome').textContent()).toContain('Undecided');
      expect(
        await page.evaluate(() => sessionStorage.getItem('galaxie:adk-recipes:demo:loan')),
      ).toBeNull();
      expect(
        await page.evaluate(async (sessionId) => {
          const database = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('adk-recipes');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            const names = [...database.objectStoreNames];
            const transaction = database.transaction(names, 'readonly');
            const keys = await Promise.all(
              names.map(
                (name) =>
                  new Promise<IDBValidKey[]>((resolve, reject) => {
                    const request = transaction.objectStore(name).getAllKeys();
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                  }),
              ),
            );
            return JSON.stringify(keys).includes(sessionId ?? 'missing-session');
          } finally {
            database.close();
          }
        }, sessionId),
      ).toBe(false);
      await page.reload();
      await expect.poll(() => page.locator('#run-status').textContent()).toContain('idle');
      expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
      await probe.verify();
    } finally {
      await probe.context.close();
    }
  },
  240000,
);

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'a model-only loan decision stays undecided without a finalize receipt'
    : missingPythonWheels,
  async () => {
    const textOnly = await builtHost([
      {
        name: 'loan-without-finalize',
        enforce: 'pre',
        transform(code, id) {
          if (!id.endsWith('/src/recipes/loan/script.ts')) return;
          return code.replace(/scenario === ['"]text-only['"]/, 'true');
        },
      },
    ]);
    const probe = await textOnly.open('loan');
    const { page } = probe;
    try {
      await page.getByRole('button', { name: 'Run', exact: true }).click();
      await completed(page);
      expect(await page.locator('#loan-outcome').textContent()).toContain('Undecided');
      expect(await page.getByRole('button', { name: 'Approve', exact: true }).count()).toBe(0);
      await probe.verify();
    } finally {
      await probe.context.close();
      await textOnly.close();
    }
  },
  180000,
);
