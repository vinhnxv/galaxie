// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { secretScanner, watchResponses } from './exposure.ts';

test('credential scanner matches across chunks and keeps clean input clear', () => {
  const scanner = secretScanner('fake-test-credential');
  scanner.push('ordinary response');
  assert.equal(scanner.detected(), false);
  scanner.push('fake-test-');
  scanner.push('credential');
  assert.equal(scanner.detected(), true);
});

test('page response inspection detects a generated fake key in finite and aborted bodies', async () => {
  const FAKE_TEST_KEY = randomBytes(31).toString('hex');
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.end('<!doctype html><title>Exposure test</title>');
      return;
    }
    if (req.url === '/empty') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.write(FAKE_TEST_KEY.slice(0, 24));
    if (req.url === '/finite') res.end(FAKE_TEST_KEY.slice(24));
    else {
      const timer = setTimeout(() => res.write(FAKE_TEST_KEY.slice(24)), 20);
      res.on('close', () => clearTimeout(timer));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const denied = createServer((_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => denied.listen(0, '127.0.0.1', resolve));
  const deniedAddress = denied.address();
  assert.ok(deniedAddress && typeof deniedAddress !== 'string');
  const browser = await chromium.launch({
    headless: true,
    args: ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1'],
  });
  try {
    for (const path of ['finite', 'abort']) {
      const page = await browser.newPage();
      const capture = await watchResponses(await page.context().newCDPSession(page), () =>
        secretScanner(FAKE_TEST_KEY),
      );
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.evaluate(async () => {
        await fetch('/empty');
      });
      const corsDenied: boolean = await page.evaluate(async (url) => {
        try {
          await fetch(url, { headers: { 'Content-Type': 'application/json' } });
          return false;
        } catch {
          return true;
        }
      }, `http://127.0.0.1:${deniedAddress.port}`);
      assert.equal(corsDenied, true);
      await page.evaluate(async (target) => {
        const controller = new AbortController();
        const response = await fetch(target, { signal: controller.signal });
        if (target === '/finite') {
          await response.text();
          return;
        }
        const reader = response.body?.getReader();
        let bytes = 0;
        while (bytes < 62) {
          const chunk = await reader?.read();
          if (!chunk || chunk.done) break;
          bytes += chunk.value.byteLength;
        }
        controller.abort();
      }, `/${path}`);
      await capture.settle();
      assert.equal(capture.detected(), true);
      await page.close();
    }
  } finally {
    await browser.close();
    denied.closeAllConnections();
    await new Promise<void>((resolve) => denied.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
