// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { cspHeader } from '../../examples/adk-recipes/src/host/csp.js';
import { missingGo } from '../../packages/starter-go/src/errors.js';
import { sourceHash } from '../../packages/starter-go/src/source-hash.js';
import { buildStarterDistOnce, cleanStarterDist, hasStarterGo } from './support/starter-go.node.js';

const available = hasStarterGo();
const repo = resolve('.');
const composed = join(repo, 'packages/create/.cache/composed/browser-only-adk-go');
const fixtures: string[] = [];

interface Project {
  readonly directory: string;
  readonly artifacts: string;
  readonly noGo: string;
  readonly buildScript: string;
}

async function project(): Promise<Project> {
  const directory = await mkdtemp(join(composed, '../.starter-go-browser-'));
  fixtures.push(directory);
  await cp(composed, directory, {
    recursive: true,
    filter: (path) => !path.includes('node_modules'),
  });
  const artifacts = join(directory, '.artifacts/starter-go');
  const dist = await buildStarterDistOnce();
  await cp(dist.directory, artifacts, { recursive: true });
  const scope = join(directory, 'node_modules/@galaxie-ai');
  await mkdir(scope, { recursive: true });
  await symlink(artifacts, join(scope, 'starter-go'), 'dir');
  const noGo = join(directory, '.no-go');
  await mkdir(noGo);
  expect(spawnSync('go', ['version'], { env: { PATH: noGo } }).error).toMatchObject({
    code: 'ENOENT',
  });
  const workspace = JSON.parse(
    await readFile(join(composed, 'tsconfig.workspace.json'), 'utf8'),
  ) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  const alias = Object.entries(workspace.compilerOptions.paths)
    .filter(([name]) => name.startsWith('@galaxie-ai/'))
    .sort(([a], [b]) => b.length - a.length)
    .map(([find, paths]) => ({ find, replacement: resolve(composed, paths[0] as string) }));
  const buildScript = join(directory, '.build.mjs');
  await writeFile(
    buildScript,
    `import { build } from ${JSON.stringify(import.meta.resolve('vite'))};
await build({ configFile: ${JSON.stringify(join(directory, 'vite.config.ts'))}, mode: 'mock', logLevel: 'silent', resolve: { alias: ${JSON.stringify(alias)} }, build: { outDir: process.argv[2], emptyOutDir: true } });
`,
  );
  return { directory, artifacts, noGo, buildScript };
}

async function buildProject(
  fixture: Project,
  name: string,
  withGo = false,
): Promise<{
  directory: string;
  status: number | null;
  output: string;
}> {
  const directory = join(fixture.directory, name);
  const child = spawn(process.execPath, [fixture.buildScript, directory], {
    cwd: fixture.directory,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PATH: withGo ? process.env['PATH'] : fixture.noGo,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  const status = await new Promise<number | null>((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  return { directory, status, output };
}

async function answer(
  directory: string,
  originKind: string,
  digest: string,
  wasmAllowed = true,
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
      await page.getByText('Keep practicing one small step at a time.', { exact: true }).waitFor();
      expect(logs).toContain(`Go starter origin=${originKind} sha256=${digest}`);
      expect(await page.evaluate(() => Reflect.get(globalThis, 'starterViolations'))).toEqual([]);
      expect(errors).toEqual([]);
      expect(requests.filter((url) => url.endsWith('/go/agent.wasm'))).toHaveLength(1);
      expect(requests.filter((url) => /go-worker.*\.js/.test(url))).toHaveLength(1);
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
  await Promise.all(fixtures.map((directory) => rm(directory, { recursive: true, force: true })));
  await cleanStarterDist();
});

describe.skipIf(!available)('the composed ADK Go browser starter', () => {
  beforeAll(async () => {
    await buildStarterDistOnce();
  }, 120_000);

  test('answers from the prebuilt with no Go, and refuses compilation without wasm-unsafe-eval', async () => {
    const fixture = await project();
    const built = await buildProject(fixture, 'prebuilt');
    expect(built.status, built.output).toBe(0);
    const { manifest } = await buildStarterDistOnce();
    await answer(built.directory, 'prebuilt', manifest.wasm.sha256);
    await answer(built.directory, 'prebuilt', manifest.wasm.sha256, false);
  }, 180_000);

  test('an edited agent without Go fails with the fixed message and emits no output', async () => {
    const fixture = await project();
    await appendFile(join(fixture.directory, 'go/agent.go'), '\n// Build an edited starter.\n');
    const built = await buildProject(fixture, 'refused');
    expect(built.status).not.toBe(0);
    expect(built.output).toContain(missingGo);
    expect(existsSync(built.directory)).toBe(false);
  }, 120_000);

  test('an edited local build answers, then its verified cache answers with no Go', async () => {
    const fixture = await project();
    await appendFile(join(fixture.directory, 'go/agent.go'), '\n// Build an edited starter.\n');
    const local = await buildProject(fixture, 'local', true);
    expect(local.status, local.output).toBe(0);
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256')
      .update(await readFile(join(local.directory, 'go/agent.wasm')))
      .digest('hex');
    await answer(local.directory, 'local', digest);
    const cached = await buildProject(fixture, 'cached');
    expect(cached.status, cached.output).toBe(0);
    await answer(cached.directory, 'cache', digest);
  }, 240_000);

  test('an unedited agent uses the prebuilt after an artifact package version bump with no Go', async () => {
    const fixture = await project();
    const { manifest } = await buildStarterDistOnce();
    const packageFile = join(fixture.artifacts, 'package.json');
    const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
    pkg.version = '0.0.1';
    await writeFile(packageFile, JSON.stringify(pkg));
    const sourceSha256 = await sourceHash(
      join(fixture.directory, 'go'),
      pkg.version,
      manifest.goModule.sha256,
    );
    expect(sourceSha256).not.toBe(manifest.sourceSha256);
    await writeFile(
      join(fixture.artifacts, 'dist/manifest.json'),
      JSON.stringify({ ...manifest, version: pkg.version, sourceSha256 }),
    );
    const built = await buildProject(fixture, 'upgraded');
    expect(built.status, built.output).toBe(0);
    await answer(built.directory, 'prebuilt', manifest.wasm.sha256);
  }, 180_000);
});
