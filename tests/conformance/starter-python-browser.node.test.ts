// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { cspHeader } from '../../examples/adk-recipes/src/host/csp.js';
import {
  buildProject,
  buildStarterDistOnce,
  cleanStarterDist,
  hasStarterPython,
  starterProject,
} from './support/starter-python.node.js';

const available = hasStarterPython();

async function answer(
  directory: string,
  digest: string,
  wasmAllowed = true,
  expected = 'Correct. Keep practicing one small step at a time.',
): Promise<void> {
  const previous = process.env['PATH'];
  process.env['PATH'] = join(dirname(directory), '.no-python');
  try {
    for (const command of ['python', 'python3', 'uv'])
      expect(spawnSync(command, ['--version']).error).toMatchObject({ code: 'ENOENT' });
    await driveAnswer(directory, digest, wasmAllowed, expected);
  } finally {
    if (previous === undefined) delete process.env['PATH'];
    else process.env['PATH'] = previous;
  }
}

async function driveAnswer(
  directory: string,
  digest: string,
  wasmAllowed = true,
  expected = 'Correct. Keep practicing one small step at a time.',
): Promise<void> {
  const header = cspHeader('mock');
  const server = await preview({
    configFile: false,
    logLevel: 'silent',
    build: { outDir: directory },
    preview: {
      host: '127.0.0.1',
      port: 0,
      strictPort: true,
      headers: {
        'Content-Security-Policy': wasmAllowed ? header : header.replace(" 'wasm-unsafe-eval'", ''),
      },
    },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('The preview has no TCP port.');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--disable-webgpu'],
  });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
      Reflect.set(globalThis, 'starterViolations', []);
      document.addEventListener('securitypolicyviolation', (event) => {
        Reflect.get(globalThis, 'starterViolations').push({
          directive: event.violatedDirective,
          file: event.sourceFile,
          line: event.lineNumber,
          sample: event.sample,
        });
      });
    });
    const external: string[] = [];
    const requests: string[] = [];
    const errors: string[] = [];
    const logs: string[] = [];
    const workerHeaders: string[] = [];
    context.on('response', (response) => {
      if (response.status() >= 400) errors.push(response.url() + ': HTTP ' + response.status());
      if (/pyodide-worker.*\.js/.test(response.url()))
        workerHeaders.push(response.headers()['content-security-policy'] ?? '');
    });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      requests.push(url);
      if (new URL(url).origin === origin) return route.continue();
      external.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      logs.push(message.text());
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('requestfailed', (request) =>
      errors.push(`${request.url()}: ${request.failure()?.errorText}`),
    );
    const response = await page.goto(origin);
    expect(response?.headers()['content-security-policy']).toBe(
      wasmAllowed ? header : header.replace(" 'wasm-unsafe-eval'", ''),
    );
    if (wasmAllowed) {
      await page.getByRole('radio', { name: '4', exact: true }).check();
      await page.getByRole('button', { name: 'Submit answers' }).click();
      await page.getByText(expected, { exact: true }).waitFor();
      expect(logs).toContain(`Python starter origin=source sha256=${digest}`);
      expect(await page.evaluate(() => Reflect.get(globalThis, 'starterViolations'))).toEqual([]);
      expect(errors).toEqual([]);
      expect(
        requests.filter((url) => url.endsWith('/python/runtime/pyodide.asm.wasm')),
      ).toHaveLength(1);
      expect(requests.filter((url) => /pyodide-worker.*\.js/.test(url))).toHaveLength(1);
      expect(workerHeaders).toEqual([header]);
    } else {
      await page.getByRole('alert').waitFor();
      expect(await page.getByRole('radio').count()).toBe(0);
      const failure = await page.evaluate(async () => {
        try {
          await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
          return null;
        } catch (error) {
          return String(error);
        }
      });
      expect(failure).toMatch(/Content Security Policy|wasm-unsafe-eval/);
    }
    expect(external).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((done, reject) => {
      server.httpServer.close((error) => (error ? reject(error) : done()));
      if ('closeAllConnections' in server.httpServer) server.httpServer.closeAllConnections();
    });
  }
}

afterAll(async () => {
  await cleanStarterDist();
});

describe.skipIf(!available)('the composed LangGraph Python browser starter', () => {
  beforeAll(async () => {
    await buildStarterDistOnce();
  }, 120_000);

  test('answers without Python and refuses compilation without wasm-unsafe-eval', async () => {
    const fixture = await starterProject();
    const built = await buildProject(fixture, 'initial');
    expect(built.status, built.output).toBe(0);
    const digest = await sourceHash(fixture.directory);
    await answer(built.directory, digest);
    await answer(built.directory, digest, false);
  }, 180_000);

  test('editing a Python agent changes its answer after rebuilding without Python', async () => {
    const fixture = await starterProject();
    const before = await sourceHash(fixture.directory);
    const path = join(fixture.directory, 'python/agent/starter_agent/graph.py');
    await writeFile(path, (await readFile(path, 'utf8')).replace('"Correct."', '"Well done."'));
    const after = await sourceHash(fixture.directory);
    expect(after).not.toBe(before);
    const built = await buildProject(fixture, 'edited');
    expect(built.status, built.output).toBe(0);
    await answer(
      built.directory,
      after,
      true,
      'Well done. Keep practicing one small step at a time.',
    );
  }, 180_000);

  test.each(['missing', 'corrupt', 'changed-manifest'])(
    'a %s wheel fails by filename before any output',
    async (kind) => {
      const fixture = await starterProject();
      const { manifest } = await buildStarterDistOnce();
      const wheel = manifest.wheels[0];
      if (wheel === undefined) throw new Error('The wheel inventory is empty.');
      const path = join(fixture.artifacts, 'dist/wheels', wheel.file);
      if (kind === 'missing') await rm(path);
      else {
        await writeFile(path, 'changed wheel');
        if (kind === 'changed-manifest') {
          const changed = structuredClone(manifest);
          const wheels = changed.wheels.map((item) =>
            item.file === wheel.file
              ? {
                  ...item,
                  bytes: 13,
                  sha256: createHash('sha256').update('changed wheel').digest('hex'),
                }
              : item,
          );
          await writeFile(
            join(fixture.artifacts, 'dist/manifest.json'),
            JSON.stringify({ ...changed, wheels }),
          );
        }
      }
      const built = await buildProject(fixture, 'refused');
      expect(built.status).not.toBe(0);
      expect(built.output).toContain(wheel.file);
      expect(existsSync(built.directory)).toBe(false);
    },
    120_000,
  );
});

describe.skipIf(!available)('runtime and notice verification', () => {
  test.each(['notice', 'runtime-manifest-hash'])(
    'a tampered %s fails the build by file name before any output',
    async (kind) => {
      const fixture = await starterProject();
      const { manifest } = await buildStarterDistOnce();
      const manifestPath = join(fixture.artifacts, 'dist/manifest.json');
      let name: string;
      if (kind === 'notice') {
        name = 'NOTICE.txt';
        const path = join(fixture.artifacts, 'dist/NOTICE.txt');
        const bytes = await readFile(path);
        bytes[0] = (bytes[0] ?? 0) ^ 1;
        await writeFile(path, bytes);
      } else {
        const runtime = manifest.runtimeFiles[0];
        if (runtime === undefined) throw new Error('The runtime inventory is empty.');
        name = runtime.file;
        const changed = {
          ...manifest,
          runtimeFiles: manifest.runtimeFiles.map((item) =>
            item.file === runtime.file ? { ...item, sha256: 'f'.repeat(64) } : item,
          ),
        };
        await writeFile(manifestPath, JSON.stringify(changed));
      }
      const built = await buildProject(fixture, 'refused');
      expect(built.status).not.toBe(0);
      expect(built.output).toContain(name);
      expect(existsSync(built.directory)).toBe(false);
    },
    120_000,
  );
});

async function sourceHash(directory: string): Promise<string> {
  const hash = createHash('sha256');
  const root = join(directory, 'python/agent');
  for (const path of (await readdir(root, { recursive: true })).sort()) {
    if (!path.endsWith('.py') && !path.endsWith('.json')) continue;
    const bytes = await readFile(join(root, path));
    hash.update(JSON.stringify([path, bytes.byteLength]));
    hash.update(bytes);
  }
  return hash.digest('hex');
}
