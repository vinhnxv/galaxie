// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cspHeader } from '../src/csp.js';
import { sentinelSentence } from '../src/mock-script.js';

interface RequestRecord {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly postData: string | null;
}

interface Observation {
  readonly requests: RequestRecord[];
  readonly errors: string[];
  readonly consoleErrors: string[];
  readonly page: Page;
  readonly context: BrowserContext;
}

const distinctiveSpans = [
  sentinelSentence,
  'Galaxie sentinel',
  'sentinel 7f3e',
  '7f3e she',
  'she walk to school',
];
function containsSentence(request: RequestRecord): boolean {
  const raw = JSON.stringify(request);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw.replaceAll('+', ' '));
  } catch {}
  return distinctiveSpans.some((span) => raw.includes(span) || decoded.includes(span));
}

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const servers: PreviewServer[] = [];
let directory: string;
let browser: Browser;
let mockOrigin: string;
let defaultOrigin: string;
let defaultEntry: string;

async function serve(mode: string): Promise<string> {
  const outDir = join(directory, mode);
  const previous = process.env['NODE_ENV'];
  try {
    process.env['NODE_ENV'] = 'production';
    await build({
      configFile,
      mode,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true, manifest: true },
    });
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous;
  }
  if (mode !== 'mock') {
    const manifest = JSON.parse(
      await readFile(join(outDir, '.vite/manifest.json'), 'utf8'),
    ) as Record<string, { file: string }>;
    const entry = manifest['src/main.tsx'];
    if (!entry) throw new Error('The exported application entry is missing.');
    defaultEntry = `/${entry.file}`;
    for (const name of await readdir(join(outDir, 'assets'))) {
      if (name.endsWith('.js'))
        expect(await readFile(join(outDir, 'assets', name), 'utf8')).not.toContain(
          sentinelSentence,
        );
    }
  }
  const server = await preview({
    configFile,
    mode,
    logLevel: 'silent',
    build: { outDir },
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  servers.push(server);
  const address = server.httpServer.address();
  if (!address || typeof address === 'string')
    throw new Error('The preview server has no TCP port.');
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'galaxie-host-local-'));
  mockOrigin = await serve('mock');
  defaultOrigin = await serve('production');
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-webgpu'] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.httpServer.close((error) => (error ? reject(error) : resolve()));
          if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
        }),
    ),
  );
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function observe(origin: string): Promise<Observation> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => {
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
    const violations: string[] = [];
    Object.assign(globalThis, { hostViolations: violations });
    addEventListener('securitypolicyviolation', (event) =>
      violations.push(event.effectiveDirective),
    );
  });
  const requests: RequestRecord[] = [];
  await context.route('**/*', async (route) => {
    const request = route.request();
    requests.push({
      url: request.url(),
      method: request.method(),
      headers: await request.allHeaders(),
      postData: request.postData(),
    });
    if (new URL(request.url()).origin !== origin) await route.abort('blockedbyclient');
    else await route.continue();
  });
  const page = await context.newPage();
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  return { requests, errors, consoleErrors, page, context };
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (globalThis as typeof globalThis & { hostViolations: string[] }).hostViolations,
  );
}

function assertLocalRequests(requests: readonly RequestRecord[], origin: string): void {
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe(origin);
    expect(request.method).toBe('GET');
    expect(containsSentence(request)).toBe(false);
  }
}

it('completes the mock lesson without sentence egress and enforces the CSP', async () => {
  const observed = await observe(mockOrigin);
  const { page, context, requests, errors, consoleErrors } = observed;
  try {
    const response = await page.goto(mockOrigin);
    expect(response?.headers()['content-security-policy']).toBe(cspHeader('mock'));
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('radio', { name: 'walk', exact: true }).waitFor();
    const questions = await page.locator('fieldset').allTextContents();
    await page.reload();
    await page.getByRole('radio', { name: 'walk', exact: true }).waitFor({ timeout: 5_000 });
    expect(await page.locator('fieldset').allTextContents()).toEqual(questions);
    await page.getByRole('radio', { name: 'walk', exact: true }).check();
    await page.getByRole('radio', { name: 'play', exact: true }).check();
    await page.getByRole('radio', { name: 'drinks', exact: true }).check();
    await page.getByRole('button', { name: 'Submit answers' }).click();
    await page.getByRole('textbox').fill('An unfinished local draft.');
    await page.reload();
    await page.getByRole('textbox').waitFor({ timeout: 5_000 });
    expect(await page.getByRole('textbox').inputValue()).toBe('');
    await page.getByRole('textbox').fill(sentinelSentence);
    await page.getByRole('button', { name: 'Submit sentence' }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Run: succeeded; Score: 2/3' }).waitFor();
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(await violations(page)).toEqual([]);
    assertLocalRequests(requests, mockOrigin);

    await page.reload();
    await page.getByRole('button', { name: 'Start', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Start', exact: true }).isEnabled()).toBe(true);
    expect(await page.getByRole('radio').count()).toBe(0);

    const negativeUrl = `${mockOrigin}/leak-control?sentence=${encodeURIComponent(sentinelSentence)}`;
    await page.evaluate(async (url) => {
      await fetch(url);
    }, negativeUrl);
    const negative = requests.filter((request) => request.url === negativeUrl);
    expect(negative).toHaveLength(1);
    expect(containsSentence(negative[0] as RequestRecord)).toBe(true);

    expect(
      await page.evaluate(async () => {
        try {
          await fetch('https://example.com/');
          return 'allowed';
        } catch {
          return 'rejected';
        }
      }),
    ).toBe('rejected');
    const cdp = await context.newCDPSession(page);
    try {
      const evaluation = await cdp.send('Runtime.evaluate', {
        expression:
          "(() => { try { eval('1 + 1'); return 'allowed'; } catch (error) { return error.name; } })()",
        allowUnsafeEvalBlockedByCSP: false,
        returnByValue: true,
      });
      expect(evaluation.result.value).toBe('EvalError');
    } finally {
      await cdp.detach();
    }
    expect(
      await page.evaluate(() => {
        try {
          document.createElement('div').innerHTML = '<b>probe</b>';
          return 'allowed';
        } catch (error) {
          return error instanceof TypeError ? 'TypeError' : 'other';
        }
      }),
    ).toBe('TypeError');
    await expect
      .poll(() => violations(page))
      .toEqual(['connect-src', 'require-trusted-types-for', 'require-trusted-types-for']);
    expect(errors).toEqual([]);
    expect(
      consoleErrors.every((message) =>
        /Content Security Policy|TrustedHTML|TrustedScript/.test(message),
      ),
    ).toBe(true);
    assertLocalRequests(
      requests.filter((request) => request.url !== negativeUrl),
      mockOrigin,
    );
  } finally {
    await context.close();
  }
}, 60_000);

it('loads default mode and constructs the bundled worker without a model or download', async () => {
  const { page, context, requests, errors, consoleErrors } = await observe(defaultOrigin);
  try {
    const response = await page.goto(defaultOrigin);
    expect(response?.headers()['content-security-policy']).toBe(cspHeader('production'));
    await page.getByRole('button', { name: 'Prepare models', exact: true }).waitFor();
    expect(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled()).toBe(true);
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    const [worker, constructed] = await Promise.all([
      page.waitForEvent('worker'),
      // Keep import() as page JavaScript; Vitest otherwise rewrites it as an SSR import.
      page.evaluate<string>(`(async () => {
        const { createWebLLMWorker } = await import(${JSON.stringify(defaultEntry)});
        await createWebLLMWorker();
        return 'constructed';
      })()`),
    ]);
    expect(constructed).toBe('constructed');
    expect(await worker.evaluate(() => 'ready')).toBe('ready');
    await expect
      .poll(() => requests.some((request) => /\/assets\/webllm-worker-/.test(request.url)))
      .toBe(true);
    expect(
      requests.some((request) => /\/assets\/(lib|worker)-|\.(wasm|bin)(\?|$)/.test(request.url)),
    ).toBe(false);
    expect(await violations(page)).toEqual([]);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    assertLocalRequests(requests, defaultOrigin);

    const workerControl = `${defaultOrigin}/worker-leak-control?sentence=${encodeURIComponent(sentinelSentence)}`;
    await worker.evaluate(async (url) => {
      await fetch(url);
    }, workerControl);
    const workerRequests = requests.filter((request) => request.url === workerControl);
    expect(workerRequests).toHaveLength(1);
    expect(containsSentence(workerRequests[0] as RequestRecord)).toBe(true);

    expect(
      await page.evaluate(() => {
        const rejected: string[] = [];
        for (const url of ['/other-worker.js', 'https://example.com/other-worker.js']) {
          try {
            new Worker(url, { type: 'module' });
            rejected.push('allowed');
          } catch (error) {
            rejected.push(error instanceof TypeError ? 'TypeError' : 'other');
          }
        }
        try {
          document.createElement('div').innerHTML = '<b>probe</b>';
          rejected.push('allowed');
        } catch (error) {
          rejected.push(error instanceof TypeError ? 'TypeError' : 'other');
        }
        return rejected;
      }),
    ).toEqual(['TypeError', 'TypeError', 'TypeError']);
    await expect.poll(() => violations(page)).toEqual(['require-trusted-types-for']);
    expect(errors).toEqual([]);
    expect(consoleErrors.every((message) => /TrustedHTML/.test(message))).toBe(true);
    assertLocalRequests(
      requests.filter((request) => request.url !== workerControl),
      defaultOrigin,
    );
  } finally {
    await context.close();
  }
}, 60_000);

const sessionKey = 'galaxie-host-local:local-demo-learner:session';

it('clears an empty stored thread and returns to the start screen', async () => {
  const { page, context, requests } = await observe(mockOrigin);
  try {
    await page.addInitScript((key) => sessionStorage.setItem(key, crypto.randomUUID()), sessionKey);
    await page.goto(mockOrigin);
    await expect
      .poll(() => page.evaluate((key) => sessionStorage.getItem(key), sessionKey))
      .toBeNull();
    await expect
      .poll(() => page.getByRole('button', { name: 'Start', exact: true }).isEnabled())
      .toBe(true);
    expect(await page.getByRole('radio').count()).toBe(0);
    assertLocalRequests(requests, mockOrigin);
  } finally {
    await context.close();
  }
}, 60_000);

it('keeps a copied session inactive while another tab holds its Web Lock', async () => {
  const { page, context, requests } = await observe(mockOrigin);
  try {
    await page.goto(mockOrigin);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('radio', { name: 'walk', exact: true }).waitFor();
    const sessionId = await page.evaluate((key) => sessionStorage.getItem(key), sessionKey);
    expect(sessionId).toBeTypeOf('string');
    const second = await context.newPage();
    await second.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), {
      key: sessionKey,
      value: sessionId as string,
    });
    await second.goto(mockOrigin);
    await second
      .getByRole('alert')
      .filter({ hasText: 'The lesson is active in another tab.' })
      .waitFor({ timeout: 5_000 });
    expect(await second.getByRole('button', { name: 'Start', exact: true }).isDisabled()).toBe(
      true,
    );
    expect(await second.getByRole('radio').count()).toBe(0);
    expect(await second.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBe(sessionId);
    expect(await page.getByRole('radio').count()).toBe(9);
    assertLocalRequests(requests, mockOrigin);
  } finally {
    await context.close();
  }
}, 60_000);

it('hands a copied lesson to Use here and leaves the former tab inert', async () => {
  const { page, context, requests, errors, consoleErrors } = await observe(mockOrigin);
  try {
    await page.goto(mockOrigin);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('radio', { name: 'walk', exact: true }).waitFor();
    const sessionId = await page.evaluate((key) => sessionStorage.getItem(key), sessionKey);
    const second = await context.newPage();
    await second.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), {
      key: sessionKey,
      value: sessionId as string,
    });
    await second.goto(mockOrigin);
    await second
      .getByRole('alert')
      .filter({ hasText: 'The lesson is active in another tab.' })
      .waitFor();
    await second.setViewportSize({ width: 390, height: 844 });
    await second.screenshot({
      path: join(tmpdir(), 'galaxie-ownership-busy-mobile.png'),
      fullPage: true,
    });
    expect(
      await second.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await second.getByRole('button', { name: 'Use here', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'The lesson moved to another tab.' }).waitFor();
    await second.getByRole('radio', { name: 'walk', exact: true }).waitFor();
    await page.screenshot({
      path: join(tmpdir(), 'galaxie-ownership-moved-desktop.png'),
      fullPage: true,
    });
    await second.screenshot({
      path: join(tmpdir(), 'galaxie-ownership-active-mobile.png'),
      fullPage: true,
    });
    expect(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled()).toBe(true);
    for (const input of await page.getByRole('radio').all())
      expect(await input.isDisabled()).toBe(true);
    expect(await second.getByRole('radio', { name: 'walk', exact: true }).isEnabled()).toBe(true);
    await second.getByRole('radio', { name: 'walk', exact: true }).check();
    await second.getByRole('radio', { name: 'play', exact: true }).check();
    await second.getByRole('radio', { name: 'drinks', exact: true }).check();
    await second.getByRole('button', { name: 'Submit answers' }).click();
    await second.getByRole('textbox').waitFor();
    expect(await page.getByRole('alert').textContent()).toBe('The lesson moved to another tab.');
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    assertLocalRequests(requests, mockOrigin);
  } finally {
    await context.close();
  }
}, 60_000);

it('keeps an operationally failed session for Retry without exposing host error text', async () => {
  const { page, context, requests, errors, consoleErrors } = await observe(mockOrigin);
  try {
    await page.goto(mockOrigin);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('radio', { name: 'walk', exact: true }).waitFor();
    const sessionId = await page.evaluate((key) => sessionStorage.getItem(key), sessionKey);
    await page.addInitScript(() => {
      const original = IDBFactory.prototype.open;
      IDBFactory.prototype.open = () => {
        IDBFactory.prototype.open = original;
        throw new Error('private-host-error-canary');
      };
    });
    await page.reload();
    await page
      .getByRole('alert')
      .filter({ hasText: 'The lesson could not be restored. Try again.' })
      .waitFor({ timeout: 5_000 });
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBe(sessionId);
    expect(await page.locator('body').textContent()).not.toContain('private-host-error-canary');
    expect(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('radio', { name: 'walk', exact: true }).waitFor({ timeout: 5_000 });
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBe(sessionId);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    assertLocalRequests(requests, mockOrigin);
  } finally {
    await context.close();
  }
}, 60_000);

it('restores an accepted sentence after a failed resume without losing its session', async () => {
  const { page, context, requests, errors, consoleErrors } = await observe(mockOrigin);
  try {
    await page.goto(mockOrigin);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('radio', { name: 'walk', exact: true }).check();
    await page.getByRole('radio', { name: 'play', exact: true }).check();
    await page.getByRole('radio', { name: 'drinks', exact: true }).check();
    await page.getByRole('button', { name: 'Submit answers' }).click();
    await page.getByRole('textbox').fill(sentinelSentence);
    const sessionId = await page.evaluate((key) => sessionStorage.getItem(key), sessionKey);
    expect(sessionId).not.toBeNull();
    await page.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      let accepted = false;
      IDBDatabase.prototype.transaction = function (
        this: IDBDatabase,
        stores: string | string[],
        mode?: IDBTransactionMode,
        options?: IDBTransactionOptions,
      ): IDBTransaction {
        const names = typeof stores === 'string' ? [stores] : stores;
        if (accepted && mode === 'readonly' && names.includes('checkpoints')) {
          IDBDatabase.prototype.transaction = original;
          throw new DOMException('private-checkpoint-read-canary', 'UnknownError');
        }
        const transaction = original.call(this, stores, mode, options);
        if (mode === 'readwrite' && names.includes('inbox'))
          transaction.addEventListener(
            'complete',
            () => {
              accepted = true;
            },
            { once: true },
          );
        return transaction;
      };
    });
    await page.getByRole('button', { name: 'Submit sentence' }).click();
    await page.getByRole('status').filter({ hasText: 'Run: failed' }).waitFor();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBe(sessionId);
    expect(await page.locator('body').textContent()).not.toContain(
      'private-checkpoint-read-canary',
    );
    await page.reload();
    await page.getByRole('button', { name: 'Continue', exact: true }).waitFor();
    expect(await page.getByRole('textbox').count()).toBe(0);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBe(sessionId);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('progressbar').waitFor();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Run: succeeded; Score: 2/3' }).waitFor();
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    assertLocalRequests(requests, mockOrigin);
  } finally {
    await context.close();
  }
}, 60_000);

async function sessionRecords(
  page: Page,
  sessionId: string,
  action: 'count' | 'corrupt' | 'version' = 'count',
): Promise<number> {
  return page.evaluate(
    ({ sessionId, action }) =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open('galaxie:galaxie-host-local');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction(
            ['checkpoints', 'meta'],
            action === 'count' ? 'readonly' : 'readwrite',
          );
          const prefix = ['galaxie-host-local', 'local-demo-learner', sessionId];
          const checkpoints = tx.objectStore('checkpoints');
          const count = checkpoints.count(IDBKeyRange.bound(prefix, [...prefix, []]));
          if (action === 'corrupt') {
            const root = [...prefix, ''];
            const cursor = checkpoints.openCursor(IDBKeyRange.bound(root, [...root, []]), 'prev');
            cursor.onsuccess = () => {
              if (cursor.result === null) {
                tx.abort();
                return;
              }
              const row = cursor.result.value;
              row.checkpoint = { v: 99, type: 'json', bytes: new Uint8Array() };
              cursor.result.update(row);
            };
          }
          if (action === 'version') {
            const meta = tx.objectStore('meta');
            const key = ['galaxie-host-local', 'local-demo-learner', 'session', sessionId];
            const stored = meta.get(key);
            stored.onsuccess = () => {
              const row = stored.result;
              row.value.agentVersion = '9.0.0';
              meta.put(row, key);
            };
          }
          tx.oncomplete = () => {
            db.close();
            resolve(count.result);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    { sessionId, action },
  );
}

it('returns to Start after eviction before a fresh page opens its saver', async () => {
  const { page, context, requests } = await observe(mockOrigin);
  try {
    await page.goto(mockOrigin);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('radio', { name: 'walk', exact: true }).waitFor();
    const sessionId = await page.evaluate((key) => sessionStorage.getItem(key), sessionKey);
    expect(sessionId).toBeTypeOf('string');
    await page.close();
    const fresh = await context.newPage();
    await fresh.addInitScript(
      ({ key, sessionId }) => {
        sessionStorage.setItem(key, sessionId);
        // Enqueued before the application can open a connection; the old page has closed.
        indexedDB.deleteDatabase('galaxie:galaxie-host-local');
      },
      { key: sessionKey, sessionId: sessionId as string },
    );
    await fresh.goto(mockOrigin);
    await expect
      .poll(() => fresh.getByRole('button', { name: 'Start', exact: true }).isEnabled())
      .toBe(true);
    expect(await fresh.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBeNull();
    expect(await fresh.getByRole('radio').count()).toBe(0);
    expect(await fresh.getByRole('alert').count()).toBe(0);
    assertLocalRequests(requests, mockOrigin);
  } finally {
    await context.close();
  }
}, 60_000);

it('keeps corrupt lesson data until Start over explicitly deletes the session', async () => {
  const { page, context, requests, errors, consoleErrors } = await observe(mockOrigin);
  try {
    await page.goto(mockOrigin);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('radio', { name: 'walk', exact: true }).waitFor();
    const sessionId = (await page.evaluate(
      (key) => sessionStorage.getItem(key),
      sessionKey,
    )) as string;
    const count = await sessionRecords(page, sessionId, 'corrupt');
    expect(count).toBeGreaterThan(0);
    await page.reload();
    await page
      .getByRole('alert')
      .filter({ hasText: 'Saved lesson cannot be recovered' })
      .waitFor({ timeout: 5_000 });
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBe(sessionId);
    expect(await sessionRecords(page, sessionId)).toBe(count);
    expect(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled()).toBe(true);
    await page.screenshot({ path: '/tmp/galaxie-recovery-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '/tmp/galaxie-recovery-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'Start over', exact: true }).click();
    await expect
      .poll(() => page.getByRole('button', { name: 'Start', exact: true }).isEnabled())
      .toBe(true);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBeNull();
    expect(await sessionRecords(page, sessionId)).toBe(0);
    expect(await page.getByRole('alert').count()).toBe(0);
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    assertLocalRequests(requests, mockOrigin);
  } finally {
    await context.close();
  }
}, 60_000);

it('starts fresh after an incompatible agent version while retaining old data', async () => {
  const { page, context } = await observe(mockOrigin);
  try {
    await page.goto(mockOrigin);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('radio', { name: 'walk', exact: true }).waitFor();
    const sessionId = (await page.evaluate(
      (key) => sessionStorage.getItem(key),
      sessionKey,
    )) as string;
    const count = await sessionRecords(page, sessionId, 'version');
    await page.reload();
    await expect
      .poll(() => page.getByRole('button', { name: 'Start', exact: true }).isEnabled())
      .toBe(true);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBeNull();
    expect(await sessionRecords(page, sessionId)).toBe(count);
  } finally {
    await context.close();
  }
}, 60_000);

it('shows a fixed quota message without host error text', async () => {
  const { page, context } = await observe(mockOrigin);
  try {
    await page.addInitScript(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (
        this: IDBObjectStore,
        ...args: Parameters<IDBObjectStore['put']>
      ) {
        if (this.name === 'meta' && Array.isArray(args[1]) && args[1][2] === 'session')
          throw new DOMException('private-quota-canary', 'QuotaExceededError');
        return original.apply(this, args);
      };
    });
    await page.goto(mockOrigin);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'Storage is full' })
      .waitFor({ timeout: 5_000 });
    expect(await page.locator('body').textContent()).not.toContain('private-quota-canary');
  } finally {
    await context.close();
  }
}, 60_000);

it('asks for reload and disables lesson input after version handover', async () => {
  const { page, context } = await observe(mockOrigin);
  try {
    await page.goto(mockOrigin);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    const input = page.getByRole('radio', { name: 'walk', exact: true });
    await input.waitFor();
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('galaxie:galaxie-host-local', 2);
          request.onerror = () => reject(request.error);
          request.onblocked = () => reject(new Error('The handover was blocked.'));
          request.onsuccess = () => {
            request.result.close();
            resolve();
          };
        }),
    );
    await page
      .getByRole('alert')
      .filter({ hasText: 'Reload to use the updated app' })
      .waitFor({ timeout: 5_000 });
    expect(await input.isDisabled()).toBe(true);
    expect(
      await page.getByRole('button', { name: 'Submit answers', exact: true }).isDisabled(),
    ).toBe(true);
    expect(await page.getByRole('button', { name: 'Start', exact: true }).isDisabled()).toBe(true);
  } finally {
    await context.close();
  }
}, 60_000);

it('observes a failed sweep once and still restores the lesson', async () => {
  const { page, context } = await observe(mockOrigin);
  try {
    await page.goto(mockOrigin);
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('radio', { name: 'walk', exact: true }).waitFor();
    const sessionId = await page.evaluate((key) => sessionStorage.getItem(key), sessionKey);
    await page.addInitScript(() => {
      const original = IDBDatabase.prototype.transaction;
      let attempts = 0;
      Object.assign(globalThis, { sweepAttempts: () => attempts });
      IDBDatabase.prototype.transaction = function (
        this: IDBDatabase,
        ...args: Parameters<IDBDatabase['transaction']>
      ) {
        const stores = typeof args[0] === 'string' ? [args[0]] : Array.from(args[0]);
        if (stores.length === 5 && args[1] === 'readonly') {
          attempts++;
          throw new DOMException('private-sweep-canary', 'QuotaExceededError');
        }
        return original.apply(this, args);
      };
    });
    await page.reload();
    await page.getByRole('radio', { name: 'walk', exact: true }).waitFor({ timeout: 5_000 });
    await page.getByRole('alert').filter({ hasText: 'Storage is full' }).waitFor();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBe(sessionId);
    expect(
      await page.evaluate(() =>
        (globalThis as typeof globalThis & { sweepAttempts(): number }).sweepAttempts(),
      ),
    ).toBe(1);
    expect(await page.locator('body').textContent()).not.toContain('private-sweep-canary');
  } finally {
    await context.close();
  }
}, 60_000);
