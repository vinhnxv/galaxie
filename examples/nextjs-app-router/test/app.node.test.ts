// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { type Browser, chromium, type Page, type Response } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { appRoot, build, gitStatus, type NextServer, serve } from './support.js';

const routes = ['langgraph', 'adk'] as const;
const mockReply = 'Keep practicing one small step at a time.';
const distDir = `.next-test/${randomUUID()}`;
const devDistDir = `${distDir}-dev`;
const runtimeMarkers = [
  'The output safety hook must be a function.',
  'The LangGraph factory and services must be valid.',
  'The routed model implementations must be valid.',
];
let initialStatus: string;
let initialEntries: string[];
let server: NextServer | undefined;
let browser: Browser | undefined;

beforeAll(async () => {
  initialStatus = gitStatus();
  initialEntries = await readdir(appRoot);
  await build(distDir);
  server = await serve('start', distDir);
  browser = await chromium.launch({ headless: true });
});

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    try {
      await server?.stop();
    } finally {
      await rm(join(appRoot, distDir), { recursive: true, force: true });
      await rm(join(appRoot, devDistDir), { recursive: true, force: true });
      expect(gitStatus()).toBe(initialStatus);
      // Only ignored build directories and Next's generated declaration may be added.
      const added = (await readdir(appRoot)).filter((name) => !initialEntries.includes(name));
      expect(added.filter((name) => name !== '.next-test' && name !== 'next-env.d.ts')).toEqual([]);
    }
  }
});

function production(): { origin: string; browser: Browser } {
  if (server === undefined || browser === undefined) throw new Error('Next was not started.');
  return { origin: server.origin, browser };
}

function directives(policy: string): Record<string, string[]> {
  return Object.fromEntries(
    policy.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

function assertPolicy(policy: string): string {
  const parsed = directives(policy);
  expect(parsed).toEqual({
    'default-src': ["'none'"],
    'script-src': ["'self'", expect.stringMatching(/^'nonce-[A-Za-z0-9+/=]+'$/)],
    'worker-src': ["'self'"],
    'connect-src': ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'"],
    'font-src': ["'self'"],
    'media-src': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'none'"],
    'object-src': ["'none'"],
    'manifest-src': ["'self'"],
    'require-trusted-types-for': ["'script'"],
    'trusted-types': ['nextjs#bundler'],
  });
  expect(policy).not.toContain("'unsafe-inline'");
  expect(policy).not.toContain("'unsafe-eval'");
  const nonce = parsed['script-src']?.[1]?.slice(7, -1);
  if (nonce === undefined) throw new Error('The request nonce is missing.');
  return nonce;
}

async function answer(page: Page): Promise<void> {
  await page.getByRole('radio', { name: '4', exact: true }).check();
  await page.getByRole('button', { name: 'Submit answers' }).click();
  await page.getByRole('status').filter({ hasText: mockReply }).waitFor();
  await page.getByText('Worker: pong', { exact: true }).waitFor();
}

test.each(routes)(
  '%s has a nonce CSP and server-rendered shell without runtime output',
  async (route) => {
    const { origin } = production();
    const first = await fetch(`${origin}/${route}`);
    const policy = first.headers.get('content-security-policy');
    expect(policy).not.toBeNull();
    const nonce = assertPolicy(policy ?? '');
    expect(first.headers.has('content-security-policy-report-only')).toBe(false);
    const html = await first.text();
    expect(first.status).toBe(200);
    expect(html).toContain(`${route === 'adk' ? 'ADK JS' : 'LangGraph.js'} browser agent`);
    expect(html).toContain('Memory-only mock example.');
    for (const marker of [...runtimeMarkers, mockReply, 'A tiny local agent'])
      expect(html).not.toContain(marker);
    const second = await fetch(`${origin}/${route}`);
    expect(assertPolicy(second.headers.get('content-security-policy') ?? '')).not.toBe(nonce);
    await second.text();

    // Inspect the raw HTML's executable inline scripts, independently of the live DOM.
    const page = await production().browser.newPage();
    page.setDefaultTimeout(60_000);
    try {
      const scripts = await page.evaluate((source) => {
        const document = new DOMParser().parseFromString(source, 'text/html');
        return [...document.scripts]
          .filter(
            (script) =>
              !script.src &&
              ['', 'module', 'text/javascript', 'application/javascript'].includes(script.type),
          )
          .map((script) => script.nonce);
      }, html);
      expect(scripts.length).toBeGreaterThan(0);
      expect(scripts.every((value) => value === nonce)).toBe(true);
    } finally {
      await page.close();
    }
  },
);

test('an unknown path renders a nonce-bearing 404 page with no policy violations', async () => {
  const { origin, browser } = production();
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // The browser logs the intentional 404 document itself; any other console error counts.
    if (message.type() === 'error' && !message.location().url.endsWith('/no-such-page'))
      errors.push(message.text());
  });
  await page.addInitScript(() => {
    const violations: string[] = [];
    Reflect.set(window, 'nextViolations', violations);
    document.addEventListener('securitypolicyviolation', (event) => {
      violations.push(`${event.effectiveDirective}: ${event.sample}`);
    });
  });
  try {
    const response = await page.goto(`${origin}/no-such-page`);
    expect(response?.status()).toBe(404);
    const headers = (await response?.allHeaders()) ?? {};
    assertPolicy(headers['content-security-policy'] ?? '');
    expect(headers['cache-control'] ?? '').not.toMatch(/s-maxage|public/);
    expect(headers['x-nonce']).toBeUndefined();
    await page.getByRole('heading', { name: 'Page not found' }).waitFor();
    // Allow hydration to finish before reading the evidence.
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => Reflect.get(window, 'nextViolations') as string[])).toEqual(
      [],
    );
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test('the server bundle and traced dependencies exclude the galaxie runtime', async () => {
  const root = join(appRoot, distDir, 'server');
  const files = await readdir(root, { recursive: true });
  const chunks = files.filter((name) => name.endsWith('.js'));
  const traces = files.filter((name) => name.endsWith('.nft.json'));
  expect(chunks.length).toBeGreaterThan(0);
  expect(traces.length).toBeGreaterThan(0);
  for (const file of chunks) {
    const source = await readFile(join(root, file), 'utf8');
    for (const marker of runtimeMarkers)
      expect(source, relative(appRoot, file)).not.toContain(marker);
  }
  for (const file of traces) {
    const trace = JSON.parse(await readFile(join(root, file), 'utf8')) as { files: string[] };
    expect(
      trace.files.filter((name) =>
        /(?:@galaxie-ai|packages\/(?:core|adapter-|models|react))/.test(name),
      ),
      file,
    ).toEqual([]);
  }
});

test.each(routes)(
  '%s answers in Chromium with no policy violations and a policy-bearing worker',
  async (route) => {
    const { origin, browser } = production();
    const page = await browser.newPage();
    page.setDefaultTimeout(60_000);
    const errors: string[] = [];
    const responses = new Map<string, Response>();
    page.context().on('response', (response) => responses.set(response.url(), response));
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const evidence: { violations: string[]; policies: string[] } = {
        violations: [],
        policies: [],
      };
      Reflect.set(window, 'nextEvidence', evidence);
      document.addEventListener('securitypolicyviolation', (event) => {
        evidence.violations.push(`${event.effectiveDirective}: ${event.sample}`);
      });
      const factory = Reflect.get(window, 'trustedTypes') as {
        createPolicy(name: string, rules: unknown): unknown;
      };
      const create = factory.createPolicy.bind(factory);
      factory.createPolicy = (name, rules) => {
        evidence.policies.push(name);
        return create(name, rules);
      };
    });
    try {
      const workerStarted = page.waitForEvent('worker');
      const response = await page.goto(`${origin}/${route}`);
      if (response === null) throw new Error('The page response is missing.');
      const pagePolicy = (await response.allHeaders())['content-security-policy'] ?? '';
      assertPolicy(pagePolicy);
      await answer(page);
      expect(errors).toEqual([]);
      const evidence = await page.evaluate(
        () => Reflect.get(window, 'nextEvidence') as { violations: string[]; policies: string[] },
      );
      expect(evidence).toEqual({ violations: [], policies: ['nextjs#bundler'] });
      const workerUrl = (await workerStarted).url();
      const worker = responses.get(workerUrl);
      if (worker === undefined) throw new Error('The worker response was not observed.');
      expect(new URL(worker.url()).origin).toBe(origin);
      expect(worker.status()).toBe(200);
      expect((await worker.allHeaders())['content-type']).toMatch(/(?:javascript|ecmascript)/);
      const workerPolicy = (await worker.allHeaders())['content-security-policy'] ?? '';
      const pageDirectives = directives(pagePolicy);
      const workerDirectives = directives(workerPolicy);
      assertPolicy(workerPolicy);
      // Nonces are response-specific; every other directive and source is identical.
      delete pageDirectives['script-src'];
      delete workerDirectives['script-src'];
      expect(workerDirectives).toEqual(pageDirectives);

      // Deliberate violations run only after recording the happy path's empty lists.
      expect(
        await page.evaluate(() => {
          const rejected = (operation: () => void): boolean => {
            try {
              operation();
              return false;
            } catch (error) {
              return error instanceof TypeError;
            }
          };
          return {
            script: rejected(() => {
              document.createElement('script').src = '/forbidden-script.js';
            }),
            worker: rejected(() => {
              new Worker(`${location.origin}/forbidden-worker.js`).terminate();
            }),
          };
        }),
      ).toEqual({ script: true, worker: true });
    } finally {
      await page.close();
    }
  },
);

test('Turbopack dev sends report-only Trusted Types and both mock routes answer', async () => {
  const dev = await serve('dev', devDistDir);
  try {
    for (const route of routes) {
      const page = await production().browser.newPage();
      page.setDefaultTimeout(60_000);
      try {
        const response = await page.goto(`${dev.origin}/${route}`);
        if (response === null) throw new Error('The dev response is missing.');
        const headers = await response.allHeaders();
        expect(headers['content-security-policy']).toBeUndefined();
        const policy = directives(headers['content-security-policy-report-only'] ?? '');
        expect(policy['require-trusted-types-for']).toEqual(["'script'"]);
        expect(policy['trusted-types']).toEqual(['nextjs#bundler']);
        expect(policy['script-src']).toContain("'unsafe-eval'");
        await answer(page);
      } finally {
        await page.close();
      }
    }
  } finally {
    await dev.stop();
  }
});

test('the index page nonces its framework scripts and links to both agents', async () => {
  const { origin, browser } = production();
  const page = await browser.newPage();
  page.setDefaultTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Reflect.set(window, 'policyViolations', []);
    document.addEventListener('securitypolicyviolation', (event) => {
      (Reflect.get(window, 'policyViolations') as string[]).push(event.effectiveDirective);
    });
  });
  try {
    for (const route of routes) {
      const response = await page.goto(origin);
      if (response === null) throw new Error('The index response is missing.');
      const nonce = assertPolicy((await response.allHeaders())['content-security-policy'] ?? '');
      const scripts = await page
        .locator('script')
        .evaluateAll((scripts: HTMLScriptElement[]) =>
          scripts
            .filter(
              (script) =>
                !script.src &&
                ['', 'module', 'text/javascript', 'application/javascript'].includes(script.type),
            )
            .map((script) => script.nonce),
        );
      expect(scripts.length).toBeGreaterThan(0);
      expect(scripts.every((value) => value === nonce)).toBe(true);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'policyViolations'))).toEqual([]);
      await page
        .getByRole('link', { name: route === 'adk' ? 'ADK JS' : 'LangGraph.js', exact: true })
        .click();
      await answer(page);
      expect(new URL(page.url()).pathname).toBe(`/${route}`);
      expect(errors).toEqual([]);
    }
  } finally {
    await page.close();
  }
});
