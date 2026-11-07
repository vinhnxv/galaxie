// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { build, loadConfigFromFile } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { cspMetaValue } from '../scripts/csp-meta.js';
import { pythonAssets } from '../scripts/python-assets.js';
import { cspHeader } from '../src/host/csp.js';

const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const cue = 'Reload the page while a review is paused to resume it. Start over clears it.';
let directory: string;
let outDir: string;
let server: Server;
let browser: Browser;
let origin: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'galaxie-rag-demo-'));
  outDir = join(directory, 'dist');
  const previousNodeEnv = process.env['NODE_ENV'];
  const previousDemo = process.env['VITE_GALAXIE_DEMO'];
  try {
    process.env['NODE_ENV'] = 'production';
    process.env['VITE_GALAXIE_DEMO'] = '1';
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'mock' }, configFile);
    if (!loaded) throw new Error('The demo build configuration could not be loaded.');
    await build({
      ...loaded.config,
      configFile: false,
      // Exercise the JavaScript demo even when the Python wheel cache is absent.
      plugins: (loaded.config.plugins ?? []).map((plugin) =>
        plugin &&
        typeof plugin === 'object' &&
        'name' in plugin &&
        plugin.name === 'rag-python-assets'
          ? pythonAssets(join(directory, 'absent-cache'))
          : plugin,
      ),
      mode: 'mock',
      publicDir: false,
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
  } finally {
    if (previousNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previousNodeEnv;
    if (previousDemo === undefined) delete process.env['VITE_GALAXIE_DEMO'];
    else process.env['VITE_GALAXIE_DEMO'] = previousDemo;
  }
  server = createServer((request, response) => {
    void (async () => {
      try {
        const pathname = decodeURIComponent(
          new URL(request.url ?? '/', 'http://localhost').pathname,
        );
        const file = resolve(outDir, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!file.startsWith(`${outDir}${sep}`)) {
          response.writeHead(404).end();
          return;
        }
        const body = await readFile(file);
        const types: Readonly<Record<string, string>> = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.json': 'application/json',
          '.wasm': 'application/wasm',
        };
        // MIME types only: no CSP header or Vite preview middleware.
        response.writeHead(200, {
          'Content-Type': types[extname(file)] ?? 'application/octet-stream',
        });
        response.end(body);
      } catch {
        response.writeHead(404).end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The static server has no port.');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-webgpu'] });
}, 60000);

afterAll(async () => {
  await browser?.close();
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function prepareModels(page: Page): Promise<void> {
  await expect
    .poll(() => page.getByRole('button', { name: 'Prepare models', exact: true }).isEnabled())
    .toBe(true);
  await page.getByRole('button', { name: 'Prepare models', exact: true }).click();
  await expect
    .poll(() => page.getByText('Chat models prepared', { exact: true }).count(), { timeout: 30000 })
    .toBe(1);
}

test('mock demo enforces meta CSP without headers and restores a paused review', async () => {
  const html = await readFile(join(outDir, 'index.html'), 'utf8');
  expect(html).toMatch(/<head>\s*<meta http-equiv="Content-Security-Policy"/);
  // The HTML serializer writes each apostrophe in the attribute as a numeric character reference.
  expect(html.replaceAll('&#39;', "'")).toContain(`content="${cspMetaValue('mock')}"`);
  expect(cspMetaValue('mock')).not.toContain('frame-ancestors');
  expect(await readFile(join(outDir, '_headers'), 'utf8')).toBe(
    `/*\n  Content-Security-Policy: ${cspHeader('mock')}\n`,
  );
  expect(cspHeader('mock')).toContain("frame-ancestors 'none'");

  const context = await browser.newContext({ serviceWorkers: 'block' });
  const requests: string[] = [];
  const policies: string[] = [];
  const errors: string[] = [];
  context.on('request', (request) => requests.push(request.url()));
  context.on('response', (response) => {
    const policy = response.headers()['content-security-policy'];
    if (policy !== undefined) policies.push(policy);
  });
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== origin) await route.abort();
    else await route.continue();
  });
  await context.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(globalThis, { demoViolations: violations });
    addEventListener('securitypolicyviolation', (event) =>
      violations.push(event.effectiveDirective),
    );
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: undefined });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const response = await page.goto(origin);
    expect(response?.headers()['content-security-policy']).toBeUndefined();
    await page.getByRole('heading', { name: 'Ask your documents', exact: true }).waitFor();
    expect(
      await page.evaluate(() => {
        const first = document.head.firstElementChild;
        return [first?.tagName, first?.getAttribute('http-equiv'), first?.getAttribute('content')];
      }),
    ).toEqual(['META', 'Content-Security-Policy', cspMetaValue('mock')]);
    const option = page.getByLabel('Review passages before answering', { exact: true });
    expect(await option.isChecked()).toBe(true);
    expect(await page.getByText(cue, { exact: true }).isVisible()).toBe(true);
    await option.uncheck();
    expect(await option.isChecked()).toBe(false);
    await option.check();
    expect(await page.evaluate(() => Reflect.get(globalThis, 'demoViolations'))).toEqual([]);

    expect(
      await page.evaluate(() => {
        try {
          document.createElement('div').innerHTML =
            '<script>globalThis.demoInjected = true</script>';
          return false;
        } catch (error) {
          return error instanceof TypeError;
        }
      }),
    ).toBe(true);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(globalThis, 'demoViolations')))
      .toContain('require-trusted-types-for');
    expect(await page.evaluate(() => Reflect.get(globalThis, 'demoInjected'))).toBeUndefined();

    await prepareModels(page);
    await page.getByLabel('Question', { exact: true }).fill('capital');
    await page.getByLabel('Search mode').selectOption('fulltext');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    const review = page.getByRole('group', { name: 'Review retrieved passages' });
    await review.waitFor({ timeout: 30000 });
    await expect.poll(() => page.getByText('Run: waiting_input', { exact: true }).count()).toBe(1);
    expect(await page.getByText(cue, { exact: true }).isVisible()).toBe(true);
    expect(await page.getByText('The paused review was restored.', { exact: true }).count()).toBe(
      0,
    );
    const reference = await page.evaluate(() => localStorage.getItem('galaxie.rag-browser.review'));
    expect(reference).not.toBeNull();
    const before = await review.textContent();
    const reloaded = await page.reload({ timeout: 15000 });
    expect(reloaded?.headers()['content-security-policy']).toBeUndefined();
    await prepareModels(page);
    await review.waitFor({ timeout: 30000 });
    expect(await review.textContent()).toBe(before);
    expect(await page.evaluate(() => localStorage.getItem('galaxie.rag-browser.review'))).toBe(
      reference,
    );
    await expect.poll(() => page.getByText('Run: waiting_input', { exact: true }).count()).toBe(1);
    expect(await page.getByText(cue, { exact: true }).isVisible()).toBe(true);
    expect(
      await page.getByText('The paused review was restored.', { exact: true }).isVisible(),
    ).toBe(true);
    await review.getByRole('checkbox', { name: 'Cities (p1)', exact: true }).uncheck();
    await review.getByRole('checkbox', { name: 'Cities (p3)', exact: true }).uncheck();
    await page.getByRole('button', { name: 'Answer with kept passages' }).click();
    await page.getByRole('heading', { name: 'Answer · LangGraph.js', exact: true }).waitFor();
    expect(await page.getByRole('list', { name: 'Cited passages' }).textContent()).toContain(
      'Lisbon',
    );
    await page.getByRole('button', { name: 'Start over', exact: true }).click();
    await expect
      .poll(() => page.getByRole('button', { name: 'Start over', exact: true }).count())
      .toBe(0);
    expect(
      await page.evaluate(() => localStorage.getItem('galaxie.rag-browser.review')),
    ).toBeNull();
    expect(await page.evaluate(() => Reflect.get(globalThis, 'demoViolations'))).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((url) => new URL(url).origin === origin)).toBe(true);
    expect(policies).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 60000);
