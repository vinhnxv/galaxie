// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { build, loadConfigFromFile, type PreviewServer, preview } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { pythonAssets } from '../scripts/python-assets.js';
import { cspHeader } from '../src/host/csp.js';

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const servers: PreviewServer[] = [];
let browser: Browser;
let directory: string;
let mockOrigin: string;
let defaultOrigin: string;
let noPythonOrigin: string;
const pythonAvailable = existsSync(
  fileURLToPath(new URL('../../../.cache/python-wheels/local-wheels.json', import.meta.url)),
);
const pasted = 'Cobalt observatories count seven violet comets.';
async function serve(mode: string, includePython = true): Promise<string> {
  const outDir = join(directory, includePython ? mode : `${mode}-without-python`);
  const previous = process.env['NODE_ENV'];
  try {
    process.env['NODE_ENV'] = 'production';
    const loaded = includePython
      ? undefined
      : await loadConfigFromFile({ command: 'build', mode }, configFile);
    await build({
      ...(loaded?.config ?? {}),
      configFile: loaded ? false : configFile,
      ...(loaded ? { plugins: [pythonAssets(join(directory, 'absent-cache'))] } : {}),
      mode,
      publicDir: false,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous;
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
  if (!address || typeof address === 'string') throw new Error('The preview has no port.');
  return `http://127.0.0.1:${address.port}`;
}
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'galaxie-rag-'));
  mockOrigin = await serve('mock');
  defaultOrigin = await serve('production');
  noPythonOrigin = await serve('mock', false);
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-webgpu'] });
}, 60000);
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
async function observe(
  origin: string,
  holdWorker = false,
  failFirstWorker = false,
  python: { hold?: boolean; corruptWheel?: boolean } = {},
): Promise<{
  page: Page;
  requests: string[];
  errors: string[];
  bodies: Promise<{ url: string; bytes: number }>[];
  release(): void;
  releasePython(): void;
}> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(globalThis, { ragViolations: violations });
    addEventListener('securitypolicyviolation', (event) =>
      violations.push(
        `${event.effectiveDirective}: ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}:${event.columnNumber} ${event.sample}`,
      ),
    );
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: undefined });
    const counts = { created: 0, terminated: 0 };
    Object.assign(globalThis, { ragPythonWorkers: counts });
    const NativeWorker = Worker;
    globalThis.Worker = class extends NativeWorker {
      private readonly python: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.python = String(url).includes('pyodide-worker');
        if (this.python) counts.created++;
      }
      override terminate(): void {
        if (this.python) counts.terminated++;
        super.terminate();
      }
    };
  });
  const requests: string[] = [];
  const errors: string[] = [];
  const gate = Promise.withResolvers<void>();
  const pythonGate = Promise.withResolvers<void>();
  if (!python.hold) pythonGate.resolve();
  let wheelCorrupted = false;
  const bodies: Promise<{ url: string; bytes: number }>[] = [];
  context.on('response', (response) => {
    if (response.url().includes('/python/') || response.url().includes('/assets/pyodide-worker'))
      bodies.push(
        response
          .body()
          .then((body) => ({ url: response.url(), bytes: body.length }))
          .catch(() => ({ url: response.url(), bytes: 0 })),
      );
  });
  let workerFailed = false;
  if (!holdWorker) gate.resolve();
  await context.route('**/*', async (route) => {
    const request = route.request();
    requests.push(`${request.url()} ${request.postData() ?? ''}`);
    if (new URL(request.url()).origin !== origin) {
      await route.abort();
      return;
    }
    if (request.url().includes('/assets/pyodide-worker')) await pythonGate.promise;
    if (python.corruptWheel && !wheelCorrupted && request.url().includes('/python/wheels/')) {
      wheelCorrupted = true;
      const response = await route.fetch();
      const body = await response.body();
      body[0] = (body[0] ?? 0) ^ 1;
      await route.fulfill({ response, body });
      return;
    }
    if (new URL(request.url()).pathname.includes('/assets/worker-')) {
      if (failFirstWorker && !workerFailed) {
        workerFailed = true;
        await route.abort();
        return;
      }
      await gate.promise;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  return {
    page,
    requests,
    errors,
    bodies,
    release: () => gate.resolve(),
    releasePython: () => pythonGate.resolve(),
  };
}
async function question(page: Page, text: string, mode = 'fulltext'): Promise<void> {
  await page.getByLabel('Question', { exact: true }).fill(text);
  await page.getByLabel('Search mode').selectOption(mode);
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect
    .poll(() => page.getByRole('heading', { name: 'Answer · LangGraph.js', exact: true }).count())
    .toBe(1);
}
function containsSubmittedText(records: readonly string[], texts: readonly string[]): boolean {
  const forms = texts.flatMap((text) => [
    text,
    encodeURIComponent(text),
    new URLSearchParams({ q: text }).toString().slice(2),
  ]);
  return records.some((record) => forms.some((form) => record.includes(form)));
}
test('request scan detects raw JSON, percent-encoded and form-encoded question leaks', () => {
  const text = 'capital of France';
  for (const record of [
    'http://127.0.0.1/telemetry {"question":"capital of France"}',
    'http://127.0.0.1/telemetry?q=capital%20of%20France',
    'http://127.0.0.1/telemetry q=capital+of+France',
  ])
    expect(containsSubmittedText([record], [text])).toBe(true);
  expect(containsSubmittedText(['http://127.0.0.1/assets/app.js'], [text])).toBe(false);
});
test('strict-CSP page indexes, answers, pastes, restores, evaluates and clears with same-origin requests', async () => {
  const observed = await observe(mockOrigin, true);
  const { page } = observed;
  try {
    await expect
      .poll(() => page.getByRole('button', { name: 'Ask', exact: true }).isDisabled())
      .toBe(true);
    expect(
      await page.getByRole('button', { name: 'Evaluate retrieval', exact: true }).isDisabled(),
    ).toBe(true);
    observed.release();
    await expect
      .poll(() => page.getByText('Ready: 12 passages (0 pasted). Device: mock.').count())
      .toBe(1);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.getByText('Chat models prepared', { exact: true }).count())
      .toBe(1);
    await page.keyboard.press('Tab');
    await page.keyboard.type('capital of France');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Home');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByRole('article').textContent()).toContain('Paris');
    expect(
      await page
        .getByRole('heading', { name: 'Answer · LangGraph.js' })
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('Tab');
    await page.keyboard.type(pasted);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.getByText('Added 1 passages.', { exact: true }).count()).toBe(1);
    await question(page, 'Cobalt observatories');
    expect(await page.getByRole('list', { name: 'Cited passages' }).textContent()).toContain(
      pasted,
    );
    await page.screenshot({ path: '/tmp/galaxie-rag-desktop.png', fullPage: true });
    await page.reload();
    await expect
      .poll(() => page.getByText('Restored: 13 passages (1 pasted). Device: mock.').count())
      .toBe(1);
    await page.getByRole('button', { name: 'Prepare models', exact: true }).click();
    await question(page, 'Cobalt observatories');
    expect(await page.getByRole('list', { name: 'Cited passages' }).textContent()).toContain(
      pasted,
    );
    await question(page, 'Show an answer without citations.', 'hybrid');
    await expect
      .poll(() =>
        page.getByText('No retrieved passage is cited for this answer.', { exact: true }).count(),
      )
      .toBe(1);
    await question(page, 'zzzxxyynothing');
    await expect
      .poll(() =>
        page
          .getByText(
            'No passages matched this question in fulltext search. Try another search mode.',
          )
          .count(),
      )
      .toBe(1);
    await page.getByLabel('Text to index').fill('x'.repeat(200001));
    expect(await page.getByText('Pasted text must be at most 200,000 characters.').count()).toBe(1);
    expect(
      await page.getByRole('button', { name: 'Index pasted text', exact: true }).isDisabled(),
    ).toBe(true);
    await page.getByLabel('Text to index').fill('');
    await page.getByRole('button', { name: 'Evaluate retrieval', exact: true }).click();
    await expect.poll(() => page.getByRole('table').count()).toBe(1);
    expect(await page.getByRole('table').textContent()).toContain('N = 10');
    expect(
      await page.getByRole('link', { name: 'CC BY-SA 4.0 license' }).getAttribute('href'),
    ).toBe('https://creativecommons.org/licenses/by-sa/4.0/');
    expect(
      await page.getByText('SQuAD v1.1, Rajpurkar et al. (2016)', { exact: false }).count(),
    ).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: '/tmp/galaxie-rag-mobile.png', fullPage: true });
    await page
      .getByRole('button', { name: 'Clear data (keep downloaded model files)', exact: true })
      .click();
    await page.getByRole('button', { name: 'Build index', exact: true }).click();
    await expect
      .poll(() => page.getByText('Ready: 12 passages (0 pasted). Device: mock.').count())
      .toBe(1);
    await page.getByRole('button', { name: 'Prepare models', exact: true }).click();
    await question(page, 'Cobalt observatories');
    await expect
      .poll(() =>
        page
          .getByText(
            'No passages matched this question in fulltext search. Try another search mode.',
          )
          .count(),
      )
      .toBe(1);
    expect(observed.requests.every((record) => record.startsWith(mockOrigin))).toBe(true);
    expect(
      containsSubmittedText(observed.requests, [
        pasted,
        'capital of France',
        'Cobalt observatories',
        'Show an answer without citations.',
        'zzzxxyynothing',
      ]),
    ).toBe(false);
    expect(
      observed.requests.some(
        (record) =>
          record.includes(pasted) ||
          record.includes('Cobalt') ||
          record.includes('capital%20of%20France'),
      ),
    ).toBe(false);
    expect(
      await page.evaluate(
        () => (globalThis as typeof globalThis & { ragViolations: string[] }).ragViolations,
      ),
    ).toEqual([]);
    expect(observed.errors).toEqual([]);
  } finally {
    observed.release();
    await page.context().close();
  }
}, 30000);

test('Retry indexing reloads a fresh Worker after a startup failure', async () => {
  const { page, requests } = await observe(mockOrigin, false, true);
  try {
    await expect
      .poll(() =>
        page.getByRole('alert').filter({ hasText: 'The retrieval Worker is unavailable.' }).count(),
      )
      .toBe(1);
    await page.getByRole('button', { name: 'Retry indexing', exact: true }).click();
    await expect
      .poll(() => page.getByText('Ready: 12 passages (0 pasted). Device: mock.').count())
      .toBe(1);
    await page.getByRole('button', { name: 'Prepare models', exact: true }).click();
    await question(page, 'capital of France');
    expect(await page.getByRole('article').textContent()).toContain('Paris');
    expect(requests.every((record) => record.startsWith(mockOrigin))).toBe(true);
  } finally {
    await page.context().close();
  }
}, 15000);

test('Cancel stops an active evaluation before another search or result table', async () => {
  const { page, errors } = await observe(mockOrigin);
  try {
    await expect
      .poll(() => page.getByText('Ready: 12 passages (0 pasted). Device: mock.').count())
      .toBe(1);
    await page.addInitScript(() => {
      const post = Worker.prototype.postMessage;
      let pending: (() => void) | undefined;
      let calls = 0;
      Worker.prototype.postMessage = function (message: unknown): void {
        if (
          message !== null &&
          typeof message === 'object' &&
          'type' in message &&
          message.type === 'search'
        ) {
          calls++;
          pending = () => post.call(this, message);
        } else post.call(this, message);
      };
      Object.assign(globalThis, {
        ragSearchGate: {
          release: () => pending?.(),
          count: () => calls,
        },
      });
    });
    await page.reload();
    await expect
      .poll(() => page.getByText('Restored: 12 passages (0 pasted). Device: mock.').count())
      .toBe(1);
    await page.getByRole('button', { name: 'Evaluate retrieval', exact: true }).click();
    await page.getByRole('button', { name: 'Cancel evaluation', exact: true }).click();
    await page.evaluate(() =>
      (
        globalThis as typeof globalThis & { ragSearchGate: { release(): void } }
      ).ragSearchGate.release(),
    );
    await expect
      .poll(() => page.getByText('Evaluation cancelled.', { exact: true }).count())
      .toBe(1);
    expect(await page.getByRole('table').count()).toBe(0);
    expect(
      await page.evaluate(() =>
        (
          globalThis as typeof globalThis & { ragSearchGate: { count(): number } }
        ).ragSearchGate.count(),
      ),
    ).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 15000);

test('a persisted page lifecycle return reloads and restores a usable host', async () => {
  const { page, errors } = await observe(mockOrigin);
  try {
    await expect
      .poll(() => page.getByText('Ready: 12 passages (0 pasted). Device: mock.').count())
      .toBe(1);
    await page.getByRole('button', { name: 'Prepare models', exact: true }).click();
    await question(page, 'capital of France');
    await page.evaluate(() =>
      dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
    );
    await page.evaluate(() =>
      dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
    );
    await expect
      .poll(() => page.getByText('Restored: 12 passages (0 pasted). Device: mock.').count())
      .toBe(1);
    await page.getByRole('button', { name: 'Prepare models', exact: true }).click();
    await question(page, 'capital of France');
    expect(await page.getByRole('article').textContent()).toContain('Paris');
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 15000);

test('default mode requests no model or WASM before consent, then refuses unavailable WebGPU', async () => {
  const { page, requests, errors } = await observe(defaultOrigin);
  try {
    const consent = page.getByRole('button', {
      name: 'Download embedding model and build index',
      exact: true,
    });
    await expect.poll(() => consent.count()).toBe(1);
    expect(
      requests.some((record) => record.includes('huggingface.co') || record.includes('.wasm')),
    ).toBe(false);
    expect(await page.getByText('No corpus file is present.', { exact: false }).count()).toBe(1);
    await consent.focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() =>
        page.getByRole('alert').filter({ hasText: 'WebGPU is required to index text.' }).count(),
      )
      .toBe(1);
    expect(await page.getByRole('button', { name: 'Retry indexing', exact: true }).count()).toBe(1);
    expect(
      requests.some((record) => record.includes('huggingface.co') || record.includes('.wasm')),
    ).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 15000);

async function preparePythonHost(page: Page): Promise<void> {
  await expect
    .poll(() => page.getByRole('button', { name: 'Prepare models', exact: true }).isEnabled())
    .toBe(true);
  await page.getByRole('button', { name: 'Prepare models', exact: true }).click();
  await expect.poll(() => page.getByText('Chat models prepared', { exact: true }).count()).toBe(1);
}
async function selectPython(page: Page): Promise<void> {
  await page.getByLabel('LangGraph Python', { exact: true }).check();
  await expect
    .poll(() => page.getByText('LangGraph Python ready', { exact: true }).count(), {
      timeout: 30000,
    })
    .toBe(1);
}
const pythonTest = test.skipIf(!pythonAvailable);
pythonTest(
  'Python switches lazily, preserves cited answers and returns to the prepared JavaScript model',
  async () => {
    const { page, requests, errors, bodies } = await observe(mockOrigin);
    try {
      expect(await page.getByLabel('LangGraph Python', { exact: true }).isDisabled()).toBe(true);
      await preparePythonHost(page);
      await question(page, 'capital of France');
      const answer = await page.locator('.answer').textContent();
      const citations = await page.getByRole('list', { name: 'Cited passages' }).textContent();
      expect(
        requests.some((url) => url.includes('/python/') || url.includes('pyodide-worker')),
      ).toBe(false);
      await selectPython(page);
      expect(await page.getByRole('article').count()).toBe(0);
      await page.getByRole('button', { name: 'Ask', exact: true }).click();
      await expect
        .poll(() =>
          page.getByRole('heading', { name: 'Answer · LangGraph Python', exact: true }).count(),
        )
        .toBe(1);
      expect(await page.locator('.answer').textContent()).toBe(answer);
      expect(await page.getByRole('list', { name: 'Cited passages' }).textContent()).toBe(
        citations,
      );
      const servedBytes = (await Promise.all(bodies)).reduce((sum, body) => sum + body.bytes, 0);
      const statedBytes = await page
        .locator('meta[name="galaxie-python-bytes"]')
        .getAttribute('content');
      expect(servedBytes).toBe(Number(statedBytes));
      await page.screenshot({ path: '/tmp/galaxie-rag-python-desktop.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: '/tmp/galaxie-rag-python-mobile.png', fullPage: true });
      await page.getByLabel('LangGraph.js', { exact: true }).check();
      expect(await page.getByRole('article').count()).toBe(0);
      await expect
        .poll(() => page.evaluate(() => Reflect.get(globalThis, 'ragPythonWorkers').terminated))
        .toBe(1);
      await question(page, 'capital of France');
      expect(await page.locator('.answer').textContent()).toBe(answer);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  },
  60000,
);

pythonTest(
  'Python boot can be cancelled, and clear and page exit release its Worker',
  async () => {
    const observed = await observe(mockOrigin, false, false, { hold: true });
    const { page } = observed;
    try {
      await preparePythonHost(page);
      await page.getByLabel('LangGraph Python', { exact: true }).check();
      await expect
        .poll(() => page.getByRole('button', { name: 'Cancel Python boot', exact: true }).count())
        .toBe(1);
      for (const name of ['Ask', 'Evaluate retrieval', 'Clear data (keep downloaded model files)'])
        expect(await page.getByRole('button', { name, exact: true }).isDisabled()).toBe(true);
      await page.getByRole('button', { name: 'Cancel Python boot', exact: true }).click();
      await expect
        .poll(() => page.getByLabel('LangGraph.js', { exact: true }).isChecked())
        .toBe(true);
      expect(await page.getByRole('alert').count()).toBe(0);
      observed.releasePython();
      await selectPython(page);
      await page
        .getByRole('button', { name: 'Clear data (keep downloaded model files)', exact: true })
        .click();
      await expect
        .poll(() => page.getByLabel('LangGraph.js', { exact: true }).isChecked())
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => Reflect.get(globalThis, 'ragPythonWorkers').terminated))
        .toBe(2);
      await page.getByRole('button', { name: 'Build index', exact: true }).click();
      await preparePythonHost(page);
      await selectPython(page);
      await page.evaluate(() =>
        dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })),
      );
      await expect
        .poll(() => page.evaluate(() => Reflect.get(globalThis, 'ragPythonWorkers').terminated))
        .toBe(3);
      expect(await page.getByLabel('LangGraph.js', { exact: true }).isChecked()).toBe(true);
      expect(observed.errors).toEqual([]);
    } finally {
      observed.releasePython();
      await page.context().close();
    }
  },
  60000,
);

pythonTest(
  'a changed wheel fails Python boot with fixed text and restores JavaScript focus',
  async () => {
    const { page, errors, requests } = await observe(mockOrigin, false, false, {
      corruptWheel: true,
    });
    try {
      await preparePythonHost(page);
      await page.getByLabel('LangGraph Python', { exact: true }).check();
      await expect
        .poll(() =>
          page
            .getByRole('alert')
            .filter({ hasText: 'The Python version could not be prepared.' })
            .count(),
        )
        .toBe(1);
      expect(await page.getByLabel('LangGraph.js', { exact: true }).isChecked()).toBe(true);
      expect(
        await page
          .getByLabel('LangGraph.js', { exact: true })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);
      expect(await page.getByRole('button', { name: 'Retry question', exact: true }).count()).toBe(
        0,
      );
      expect(requests.some((url) => url.includes('pyodide.asm.wasm'))).toBe(false);
      await question(page, 'capital of France');
      await selectPython(page);
      expect(errors).toEqual([]);
    } finally {
      await page.context().close();
    }
  },
  60000,
);

test('a build without the wheel cache omits the Python choice', async () => {
  const { page, errors } = await observe(noPythonOrigin);
  try {
    await expect
      .poll(() =>
        page.getByText('Python version not included in this build', { exact: true }).count(),
      )
      .toBe(1);
    expect(await page.getByLabel('LangGraph Python', { exact: true }).count()).toBe(0);
    await preparePythonHost(page);
    await question(page, 'capital of France');
    expect(errors).toEqual([]);
  } finally {
    await page.context().close();
  }
}, 15000);

test('the Pyodide Worker keeps same-origin connections under the default page header', async () => {
  const { page, requests } = await observe(defaultOrigin);
  try {
    await page.getByRole('heading', { name: 'Ask your documents', exact: true }).waitFor();
    const name = (await readdir(join(directory, 'production/assets'))).find(
      (file) => file.startsWith('pyodide-worker-') && file.endsWith('.js'),
    );
    expect(name).toBeDefined();
    const url = `${defaultOrigin}/assets/${name}`;
    const response = await page.request.get(url);
    expect(response.headers()['content-security-policy']).toBe(cspHeader('mock'));
    const [worker] = await Promise.all([
      page.waitForEvent('worker'),
      page.evaluate((url) => {
        Object.assign(globalThis, { ragCspWorker: new Worker(url, { type: 'module' }) });
      }, url),
    ]);
    const directive = await worker.evaluate(
      () =>
        new Promise<string>((resolve) => {
          addEventListener(
            'securitypolicyviolation',
            (event) => resolve(event.effectiveDirective),
            { once: true },
          );
          void fetch('https://huggingface.co').catch(() => {});
        }),
    );
    expect(directive).toBe('connect-src');
    expect(requests.some((url) => url.includes('huggingface.co'))).toBe(false);
    await page.evaluate(() => Reflect.get(globalThis, 'ragCspWorker').terminate());
  } finally {
    await page.context().close();
  }
}, 15000);

pythonTest(
  'a Python reboot failure after cancellation uses the boot alert and restores JavaScript',
  async () => {
    const { page, errors } = await observe(mockOrigin);
    const corrupt = Promise.withResolvers<void>();
    try {
      await page.addInitScript(() => {
        const post = Worker.prototype.postMessage;
        let held = false;
        Worker.prototype.postMessage = function (message: unknown): void {
          if (typeof message === 'string') {
            const value = JSON.parse(message) as { op: string; kind: string; ok?: boolean };
            if (!held && value.op === 'model' && value.kind === 'response' && value.ok) {
              held = true;
              Object.assign(globalThis, { ragHeldModel: true });
              return;
            }
          }
          post.call(this, message);
        };
      });
      await page.reload();
      await preparePythonHost(page);
      await selectPython(page);
      await page.getByLabel('Question', { exact: true }).fill('capital of France');
      await page.getByRole('button', { name: 'Ask', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => Reflect.get(globalThis, 'ragHeldModel')))
        .toBe(true);
      expect(await page.getByLabel('LangGraph.js', { exact: true }).isDisabled()).toBe(true);
      await page.getByRole('button', { name: 'Cancel answer', exact: true }).click();
      await expect.poll(() => page.getByText('Run: cancelled', { exact: true }).count()).toBe(1);
      await page.context().route(
        '**/python/wheels/*.whl',
        async (route) => {
          await corrupt.promise;
          const response = await route.fetch();
          const body = await response.body();
          body[0] = (body[0] ?? 0) ^ 1;
          await route.fulfill({ response, body });
        },
        { times: 1 },
      );
      await page.getByRole('button', { name: 'Ask', exact: true }).click();
      await expect
        .poll(() => page.getByText('Preparing LangGraph Python…', { exact: true }).count())
        .toBe(1);
      expect(await page.getByRole('button', { name: 'Ask', exact: true }).isDisabled()).toBe(true);
      corrupt.resolve();
      await expect
        .poll(() =>
          page
            .getByRole('alert')
            .filter({ hasText: 'The Python version could not be prepared.' })
            .count(),
        )
        .toBe(1);
      expect(await page.getByLabel('LangGraph.js', { exact: true }).isChecked()).toBe(true);
      expect(await page.getByRole('button', { name: 'Retry question', exact: true }).count()).toBe(
        0,
      );
      expect(
        await page
          .getByLabel('LangGraph.js', { exact: true })
          .evaluate((element) => element === document.activeElement),
      ).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      corrupt.resolve();
      await page.context().close();
    }
  },
  60000,
);
