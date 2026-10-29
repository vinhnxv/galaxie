// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { type Browser, chromium } from 'playwright';
import { build, createServer, type ViteDevServer } from 'vite';
import type {} from '../src/main.ts';
import { type Fixtures, startFixtures } from './servers.ts';

interface Observation {
  name: string;
  status: 'passed' | 'observed';
  elapsedMs: number;
  details: unknown;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const observations: Observation[] = [];
const viteServers: ViteDevServer[] = [];
let fixtures: Fixtures | undefined;
let browser: Browser | undefined;
let currentCheck = 'startup';

async function check(
  name: string,
  fn: () => Promise<unknown>,
  status: Observation['status'] = 'observed',
): Promise<void> {
  currentCheck = name;
  const started = performance.now();
  const details = await fn();
  observations.push({ name, status, elapsedMs: performance.now() - started, details });
  // Only fixed check names are printed, never provider or transport errors.
  console.log(`${name}: ${status}`);
}

try {
  fixtures = await startFixtures();
  const fixture = fixtures;
  const { origins } = fixture;
  for (const port of [4180, 4184]) {
    const server = await createServer({
      root,
      configFile: false,
      logLevel: 'silent',
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null },
    });
    viteServers.push(server);
    await server.listen();
  }
  // Request interception suppresses Chromium preflights. A failing loopback proxy
  // blocks non-loopback traffic without intercepting the CORS path under test.
  browser = await chromium.launch({
    headless: true,
    args: ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1'],
  });
  const context = await browser.newContext();
  let forbiddenRequests = 0;
  context.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1') forbiddenRequests++;
  });
  const page = await context.newPage();
  let upstreamKeyVisible = false;
  const inspections: Promise<void>[] = [];
  page.on('console', (message) => {
    if (fixture.containsUpstreamKey(message.text())) upstreamKeyVisible = true;
  });
  page.on('pageerror', (error) => {
    if (fixture.containsUpstreamKey(error.message)) upstreamKeyVisible = true;
  });
  page.on('response', (response) => {
    inspections.push(
      (async () => {
        if (fixture.containsUpstreamKey(JSON.stringify(await response.allHeaders())))
          upstreamKeyVisible = true;
        // These finite responses cover every page-visible model/proxy response.
        // MCP's standing GET event stream never finishes and contains no upstream key.
        if (!response.url().startsWith(origins.mcp)) {
          try {
            if (fixture.containsUpstreamKey((await response.body()).toString()))
              upstreamKeyVisible = true;
          } catch {
            /* An aborted stream has no complete body. */
          }
        }
      })(),
    );
  });
  await page.goto(origins.page);
  await page.waitForFunction(() => Boolean(window.probes));

  async function credential(): Promise<string> {
    return page.evaluate((proxy) => window.probes.token(proxy), origins.proxy);
  }
  const browserToken = await credential();
  const errors: { credentialFree?: boolean }[] = [];
  async function model(
    path: 'proxy' | 'upstream',
    action: 'invoke' | 'stream' | 'abort' | 'structured' | 'supplier' | 'default-retry',
    name = 'normal',
    key?: string,
    noCors = false,
  ): Promise<Record<string, unknown>> {
    const result = await page.evaluate((options) => window.probes.modelProbe(options), {
      baseURL: `${origins[path]}${noCors ? '/no-cors' : ''}/v1`,
      key: key ?? (path === 'proxy' ? await credential() : fixture.userKey),
      model: name,
      action,
      proxy: origins.proxy,
    });
    if (result['error']) errors.push(result['error'] as { credentialFree?: boolean });
    return result;
  }

  for (const path of ['proxy', 'upstream'] as const) {
    await check(`${path}.prefetch`, async () => {
      const result = await model(path, 'invoke');
      assert.equal(result['completed'], true);
      assert.equal(result['usage'], 7);
      return result;
    });
    await check(`${path}.cors`, async () => {
      const records = fixture.requests.filter((r) => r.server === path);
      const preflights = records.filter((r) => r.method === 'OPTIONS');
      assert.ok(
        preflights.some((r) =>
          r.headers['access-control-request-headers']?.includes('authorization'),
        ),
      );
      return {
        preflights,
        sdkHeaders: records
          .filter(
            (r) =>
              r.method === 'POST' &&
              r.path.includes('/v1/') &&
              r.headers['origin'] === origins.page,
          )
          .map((r) => r.headers),
      };
    });
    await check(`${path}.stream`, async () => {
      const result = await model(path, 'stream');
      assert.equal(result['error'], null);
      assert.equal(result['usage'], true);
      return result;
    });
    await check(`${path}.abort`, async () => {
      const before = fixture.requests.length;
      const result = await model(path, 'abort', 'slow');
      assert.equal(typeof result['abortAt'], 'number');
      const deadline = Date.now() + 5000;
      while (
        !fixture.requests
          .slice(before)
          .some((r) => r.server === 'upstream' && r.model === 'slow' && r.closedAt) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 10));
      const closed = fixture.requests
        .slice(before)
        .find((r) => r.server === 'upstream' && r.model === 'slow' && r.closedAt)?.closedAt;
      assert.ok(closed);
      return { ...result, upstreamCloseDelayMs: closed - Number(result['abortAt']) };
    });
    for (const status of [401, 429, 500])
      await check(`${path}.error.${status}`, async () => {
        const result = await model(path, 'invoke', `error-${status}`);
        assert.equal(result['completed'], false);
        assert.equal((result['error'] as { status: number }).status, status);
        return result;
      });
  }
  await check('proxy.supplier', async () => {
    const result = await model('proxy', 'supplier');
    assert.equal(result['completed'], true);
    assert.equal(result['callsAfterConstruction'], 0);
    assert.equal((result['supplierAt'] as number[]).length, 2);
    return result;
  });
  async function retryProbe(): Promise<void> {
    await check('proxy.default-retries', async () => {
      const before = fixture.requests.length;
      const result = await model('proxy', 'default-retry', 'error-500');
      assert.equal(result['completed'], false);
      const attempts = fixture.requests
        .slice(before)
        .filter((r) => r.server === 'upstream' && r.model === 'error-500');
      return {
        ...result,
        attempts: attempts.length,
        retryCount: attempts.length - 1,
        backoffMs: attempts.slice(1).map((r, i) => r.at - (attempts[i]?.at ?? r.at)),
      };
    });
  }
  await check('proxy.structured', async () => {
    const result = await model('proxy', 'structured');
    assert.equal(result['valid'], true);
    const shape = fixture.requests.findLast(
      (r) => r.server === 'upstream' && r.responseFormat,
    )?.responseFormat;
    assert.ok(shape);
    return { ...result, responseFormat: shape };
  });
  await check('upstream.no-cors', async () => {
    const result = await model('upstream', 'invoke', 'normal', fixture.userKey, true);
    assert.equal(result['completed'], false);
    assert.equal((result['error'] as { status: unknown }).status, null);
    return result;
  });
  await check('proxy.expired-token', async () => {
    fixture.expireTokens();
    const result = await model('proxy', 'invoke', 'normal', browserToken);
    assert.equal((result['error'] as { status: number }).status, 401);
    return result;
  });

  async function admin(action: string): Promise<void> {
    const response = await fetch(`${origins.mcp}/admin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${fixture.adminKey}` },
      body: JSON.stringify({ action }),
      redirect: 'error',
    });
    assert.equal(response.status, 200);
  }
  const mcpKey = fixture.issueMcpCredential('learner-a');
  await check('mcp.initialize', async () => {
    const result = await page.evaluate(({ url, key }) => window.probes.connect(url, key), {
      url: `${origins.mcp}/mcp`,
      key: mcpKey,
    });
    assert.equal(result.sessionVisible, true);
    assert.equal(result.protocolVersion, '2025-11-25');
    return result;
  });
  await check('mcp.first-seen-and-approval', async () => {
    const before = await page.evaluate(() => window.probes.list());
    assert.equal(before?.length, 2);
    assert.ok(before?.every((r) => !r.enabled));
    const denied = await page.evaluate(() => window.probes.call());
    assert.equal(denied.completed, false);
    await page.evaluate(() => window.probes.approve('lesson.lookup'));
    const after = await page.evaluate(() => window.probes.list());
    const allowed = await page.evaluate(() => window.probes.call());
    assert.equal(allowed.completed, true);
    return { before, denied, after, allowed };
  });
  await check('mcp.changed-definition', async () => {
    await admin('change');
    const changed = await page.evaluate(() => window.probes.list());
    assert.ok(changed?.every((r) => !r.enabled));
    const denied = await page.evaluate(() => window.probes.call());
    assert.equal(denied.completed, false);
    await page.evaluate(() => window.probes.approve('lesson.lookup'));
    const allowed = await page.evaluate(() => window.probes.call());
    assert.equal(allowed.completed, true);
    return { changed, denied, allowed };
  });
  await check('mcp.parsed-limit', async () => {
    const before = await page.evaluate(() => window.probes.stats());
    await page.evaluate(() => window.probes.caps(32_768, 512));
    const result = await page.evaluate(() => window.probes.call(2048));
    const after = await page.evaluate(() => window.probes.stats());
    assert.equal(result.completed, false);
    assert.equal(after?.parsedRejected, true);
    assert.equal(after?.deliveredResults, before?.deliveredResults);
    return { result, before, after };
  });
  await check('mcp.wire-limit', async () => {
    const before = await page.evaluate(() => window.probes.stats());
    await page.evaluate(() => window.probes.caps(1024, 16_384));
    const result = await page.evaluate(() => window.probes.call(4096));
    const after = await page.evaluate(() => window.probes.stats());
    assert.equal(result.completed, false);
    assert.equal(after?.wireRejected, true);
    assert.equal(after?.parsedResults, before?.parsedResults);
    assert.equal(after?.deliveredResults, before?.deliveredResults);
    await page.evaluate(() => window.probes.caps(32_768, 16_384));
    return { result, before, after, customFetchAccepted: true };
  });
  await check('mcp.sampling-rejected', async () => {
    await admin('sampling');
    const result = await page.evaluate(() => window.probes.call());
    assert.equal(result.completed, true);
    assert.equal(fixture.sampling.at(-1)?.rejected, true);
    assert.equal(fixture.sampling.at(-1)?.code, -32601);
    return { clientCapabilities: {}, result, server: fixture.sampling };
  });
  await check('mcp.session-404', async () => {
    await admin('forget');
    const before = fixture.requests.filter((r) => r.protocolMethod === 'initialize').length;
    const result = await page.evaluate(() => window.probes.call());
    assert.equal(result.completed, false);
    const automaticInitializations =
      fixture.requests.filter((r) => r.protocolMethod === 'initialize').length - before;
    const reconnected = await page.evaluate(({ url, key }) => window.probes.connect(url, key), {
      url: `${origins.mcp}/mcp`,
      key: mcpKey,
    });
    const disabled = await page.evaluate(() => window.probes.list());
    assert.ok(disabled?.every((r) => !r.enabled));
    await page.evaluate(() => window.probes.approve('lesson.lookup'));
    const resumed = await page.evaluate(() => window.probes.call());
    assert.equal(resumed.completed, true);
    return {
      result,
      automaticInitializations,
      reconnected,
      disabled,
      resumed,
      writeRetried: false,
    };
  });
  const deniedPage = await context.newPage();
  await deniedPage.goto(origins.denied);
  await deniedPage.waitForFunction(() => Boolean(window.probes));
  for (const service of ['proxy', 'mcp'] as const)
    await check(`${service}.denied-origin`, async () => {
      const url = `${origins[service]}${service === 'mcp' ? '/mcp' : '/token'}`;
      const browserResult =
        service === 'mcp'
          ? await deniedPage.evaluate(
              async ({ target, key }) => {
                try {
                  await window.probes.connect(target, key);
                  return { status: 200, errorClass: null };
                } catch (error) {
                  return { status: null, errorClass: (error as Error).constructor.name };
                }
              },
              { target: url, key: mcpKey },
            )
          : await deniedPage.evaluate(async (target) => {
              try {
                return {
                  status: (
                    await fetch(target, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: '{}',
                    })
                  ).status,
                  errorClass: null,
                };
              } catch (error) {
                return { status: null, errorClass: (error as Error).constructor.name };
              }
            }, url);
      const response = await fetch(url, {
        method: 'POST',
        headers: { Origin: origins.denied },
        redirect: 'error',
      });
      assert.equal(browserResult.status, null);
      assert.equal(response.status, 403);
      return { browser: browserResult, nodeStatus: response.status };
    });
  await retryProbe();
  await page.evaluate(() => window.probes.close());
  await deniedPage.close();
  await Promise.all(inspections);
  await check(
    'credentials.exposure',
    async () => {
      const result = {
        upstreamKeyAbsentFromPage: !upstreamKeyVisible,
        browserTokenNotForwarded: !fixture.exposure().browserTokenForwarded,
        errorsCredentialFree: errors.every((r) => r.credentialFree === true),
        userKeyInPageMemoryOnly: true,
        forbiddenRequests,
      };
      assert.equal(result.upstreamKeyAbsentFromPage, true);
      assert.equal(result.browserTokenNotForwarded, true);
      assert.equal(result.errorsCredentialFree, true);
      assert.equal(forbiddenRequests, 0);
      return result;
    },
    'passed',
  );

  await check('bundle.cost', async () => {
    const bundles: { entry: string; bytes: number; gzipBytes: number; dependencies: string[] }[] =
      [];
    for (const entry of ['index.html', 'src/mcp.ts']) {
      const dependencies = new Set<string>();
      let bytes = 0;
      let gzipBytes = 0;
      await build({
        root,
        configFile: false,
        logLevel: 'silent',
        build: {
          write: false,
          rolldownOptions: {
            input: `${root}/${entry}`,
            ...(entry.endsWith('.ts') ? { preserveEntrySignatures: 'strict' as const } : {}),
          },
        },
        plugins: [
          {
            name: 'spike-cost',
            generateBundle(_options, output) {
              for (const artifact of Object.values(output))
                if (artifact.type === 'chunk') {
                  bytes += Buffer.byteLength(artifact.code);
                  gzipBytes += gzipSync(artifact.code).byteLength;
                  for (const id of Object.keys(artifact.modules)) {
                    const dependency =
                      /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(
                        id,
                      )?.[1];
                    if (dependency) dependencies.add(dependency);
                  }
                }
            },
          },
        ],
      });
      bundles.push({ entry, bytes, gzipBytes, dependencies: [...dependencies].sort() });
    }
    return bundles;
  });
  const version = browser.version();
  const result = {
    recordedAt: new Date().toISOString(),
    browser: `Headless Chromium ${version}`,
    origins,
    observations,
    requests: fixture.requests,
    notTested: [
      'localhost/Ollama and Chrome LNA',
      'real providers',
      'headed and other browsers',
      'HTTP/2',
      'device matrix',
    ],
  };
  assert.equal(fixture.containsUpstreamKey(JSON.stringify(result)), false);
  for (const secret of [browserToken, fixture.userKey, fixture.adminKey, mcpKey])
    assert.equal(JSON.stringify(result).includes(secret), false);
  await mkdir(`${root}/results`, { recursive: true });
  await writeFile(
    `${root}/results/${new Date().toISOString().slice(0, 10)}-headless-chromium-${version}.json`,
    `${JSON.stringify(result, null, 2)}\n`,
  );
} catch {
  // No raw assertion, SDK or host error crosses this boundary.
  console.error(`record_failed:${currentCheck}`);
  console.error(
    JSON.stringify({
      lastObservation: observations.at(-1),
      requests: fixtures?.requests.slice(-3),
    }),
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
  for (const server of viteServers) await server.close();
  await fixtures?.close();
}
