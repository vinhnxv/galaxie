// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium } from 'playwright';
import { build, type PreviewServer, preview } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';

const template = fileURLToPath(new URL('..', import.meta.url));
const configFile = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
let directory: string | undefined;
let server: PreviewServer | undefined;
let browser: Browser | undefined;
let origin: string;

beforeAll(async () => {
  directory = await mkdtemp(join(template, '.reload-check-'));
  const workspace = JSON.parse(
    await readFile(new URL('../tsconfig.workspace.json', import.meta.url), 'utf8'),
  ) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  const alias = Object.entries(workspace.compilerOptions.paths)
    .filter(([name]) => name.startsWith('@galaxie/'))
    .sort(([a], [b]) => b.length - a.length)
    .map(([find, paths]) => {
      const path = paths[0];
      if (path === undefined) throw new Error('The workspace source mapping is missing.');
      return { find, replacement: fileURLToPath(new URL(path, new URL('../', import.meta.url))) };
    });
  const previous = process.env['NODE_ENV'];
  try {
    process.env['NODE_ENV'] = 'production';
    await build({
      configFile,
      mode: 'mock',
      logLevel: 'silent',
      resolve: { alias },
      build: { outDir: directory, emptyOutDir: true },
    });
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous;
  }
  server = await preview({
    configFile,
    mode: 'mock',
    logLevel: 'silent',
    build: { outDir: directory },
    preview: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  const address = server.httpServer.address();
  if (address === null || typeof address === 'string')
    throw new Error('The preview has no TCP port.');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu', '--disable-webgpu'] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (server !== undefined) {
    const current = server;
    await new Promise<void>((resolve, reject) => {
      current.httpServer.close((error) => (error ? reject(error) : resolve()));
      if ('closeAllConnections' in current.httpServer) current.httpServer.closeAllConnections();
    });
  }
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
});

it('reloads the built app under CSP with the same pending question and no model downloads', async () => {
  if (browser === undefined) throw new Error('Chromium did not start.');
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addInitScript(() => {
    Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  });
  const requests: string[] = [];
  const errors: string[] = [];
  await context.route('**/*', async (route) => {
    requests.push(route.request().url());
    if (new URL(route.request().url()).origin !== origin) await route.abort('blockedbyclient');
    else await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const response = await page.goto(origin);
    expect(response?.headers()['content-security-policy']).toContain(
      "require-trusted-types-for 'script'",
    );
    await page.getByRole('radio', { name: '4', exact: true }).waitFor();
    const question = await page.locator('form').textContent();
    const saved = await page.evaluate(() =>
      sessionStorage.getItem('local-only-template.local-demo-principal.session'),
    );
    expect(saved).not.toBeNull();
    await page.reload();
    await page.getByRole('radio', { name: '4', exact: true }).waitFor();
    expect(await page.locator('form').textContent()).toBe(question);
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem('local-only-template.local-demo-principal.session'),
      ),
    ).toBe(saved);
    await page.getByRole('radio', { name: '4', exact: true }).check();
    await page.getByRole('button', { name: 'Submit answers' }).click();
    await page
      .getByText('Correct. Keep practicing one small step at a time.', { exact: true })
      .waitFor();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((url) => new URL(url).origin === origin)).toBe(true);
    expect(requests.some((url) => /webllm|\.wasm|huggingface|\.hf\.co/.test(url))).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
