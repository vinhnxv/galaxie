// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Request } from 'playwright';
import type { PackageManager } from '../packages/create/src/packages.js';
import type { Mode, NodeRequest, Result, Step, TemplateSpec } from './standalone-core.js';

export interface Arguments {
  kind: 'browser-only' | 'gateway' | 'all';
  framework: 'langgraph-js' | 'adk-js' | 'adk-go' | 'langgraph-python';
  nodes: NodeRequest[];
  mode: Mode | 'both';
  packageManager: PackageManager;
  tarballs?: string;
  json?: string;
  exclude?: string;
  keep: boolean;
  cleanPath: boolean;
  budgetMinutes: number;
  serverBudgetMinutes: number;
  help: boolean;
}
export const usage = `Usage: node scripts/verify-standalone.ts [options]
  --kind browser-only|gateway|all             (default all)
  --framework langgraph-js|adk-js|adk-go|langgraph-python
                                            (default langgraph-js; others are tarball-only)
  --node <major>[=/path/to/node]            (repeatable; default current)
  --mode registry|tarball|both              (default registry)
  --package-manager npm|pnpm|yarn          (default npm; pnpm and yarn need Corepack and tarball mode)
  --tarballs <directory>                   reuse seven packed launch packages
  --json <file>                            write the result array
  --min-release-age-exclude <pattern>       explicit, recorded npm exclusion
  --keep                                  retain and print the temporary root
  --clean-path                            project PATH contains only node and sh
  --budget-minutes <n>                     scaffold through preview, integer 1 to 60 (default 10)
  --server-budget-minutes <n>              gateway compile and drive, integer 1 to 60 (default 2)
  --help
Node versions are never downloaded. Missing Node 22: nvm install 22.
Packing needs pnpm on PATH and this workspace's installed build tooling.
Chromium: pnpm exec playwright install chromium.`;

export function parseArguments(args: readonly string[]): Arguments {
  const options: Arguments = {
    kind: 'all',
    framework: 'langgraph-js',
    nodes: [],
    mode: 'registry',
    packageManager: 'npm',
    keep: false,
    cleanPath: false,
    budgetMinutes: 10,
    serverBudgetMinutes: 2,
    help: false,
  };
  const invalid: () => never = () => {
    throw new Error(usage);
  };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help') {
      options.help = true;
      continue;
    }
    if (flag === '--keep') {
      options.keep = true;
      continue;
    }
    if (flag === '--clean-path') {
      options.cleanPath = true;
      continue;
    }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) invalid();
    switch (flag) {
      case '--kind':
        if (value !== 'all' && value !== 'browser-only' && value !== 'gateway') invalid();
        options.kind = value;
        break;
      case '--framework':
        if (
          value !== 'langgraph-js' &&
          value !== 'adk-js' &&
          value !== 'adk-go' &&
          value !== 'langgraph-python'
        )
          invalid();
        options.framework = value;
        break;
      case '--mode':
        if (value !== 'registry' && value !== 'tarball' && value !== 'both') invalid();
        options.mode = value;
        break;
      case '--package-manager':
        if (value !== 'npm' && value !== 'pnpm' && value !== 'yarn') invalid();
        options.packageManager = value;
        break;
      case '--node': {
        const match = /^(\d+)(?:=(.+))?$/.exec(value);
        if (match === null || Number(match[1]) < 22) invalid();
        const major = Number(match[1]);
        if (options.nodes.some((node) => node.major === major)) invalid();
        options.nodes.push(match[2] === undefined ? { major } : { major, path: match[2] });
        break;
      }
      case '--tarballs':
        options.tarballs = resolve(value);
        break;
      case '--json':
        options.json = resolve(value);
        break;
      case '--min-release-age-exclude':
        options.exclude = value;
        break;
      case '--budget-minutes':
      case '--server-budget-minutes': {
        const minutes = Number(value);
        if (!/^\d+$/.test(value) || !Number.isInteger(minutes) || minutes < 1 || minutes > 60)
          invalid();
        if (flag === '--budget-minutes') options.budgetMinutes = minutes;
        else options.serverBudgetMinutes = minutes;
        break;
      }
      default:
        invalid();
    }
  }
  if (!options.help && options.framework !== 'langgraph-js' && options.mode !== 'tarball')
    invalid();
  if (
    !options.help &&
    options.packageManager !== 'npm' &&
    (options.mode !== 'tarball' || options.exclude !== undefined)
  )
    invalid();
  if (options.nodes.length === 0)
    options.nodes.push({ major: Number(process.versions.node.split('.')[0]) });
  return options;
}

const vite = 'node_modules/vite/bin/vite.js';
const tsc = 'node_modules/typescript/bin/tsc';
const langGraphSpecs: readonly TemplateSpec[] = [
  {
    name: 'browser-only-langgraph-js',
    kind: 'browser-only',
    framework: 'langgraph-js',
    build: [vite, 'build'],
    preview: [vite, 'preview'],
    steps: [
      { action: 'check', role: 'radio', name: '4' },
      { action: 'click', role: 'button', name: 'Submit answers' },
      { action: 'text', name: 'Correct. Keep practicing one small step at a time.' },
    ],
  },
  {
    name: 'gateway-langgraph-js',
    kind: 'gateway',
    framework: 'langgraph-js',
    build: [vite, 'build'],
    preview: [vite, 'preview'],
    probeSession: true,
    server: {
      compile: [tsc, '-p', 'server/tsconfig.json'],
      entry: '.server/server/serve.js',
      port: 4173,
      steps: [
        { action: 'click', role: 'button', name: 'Start with gateway' },
        { action: 'check', role: 'radio', name: '4' },
        {
          action: 'click',
          role: 'button',
          name: 'Submit answers',
          unavailable: {
            path: '/api/v1/chat/completions',
            text: 'The gateway is unavailable. Retry later.',
          },
        },
        { action: 'visible', role: 'button', name: 'Retry' },
      ],
    },
    steps: [
      { action: 'click', role: 'button', name: 'Start with gateway' },
      { action: 'check', role: 'radio', name: '4' },
      { action: 'click', role: 'button', name: 'Submit answers' },
      { action: 'text', name: 'Correct. This is a fixed reply from the mock upstream.' },
      { action: 'text', name: 'Replies are fixed sample text from a mock upstream.' },
    ],
  },
];

export const templateSpecs: readonly TemplateSpec[] = [
  ...langGraphSpecs,
  ...langGraphSpecs.map(
    (spec): TemplateSpec => ({
      ...spec,
      name: `${spec.kind}-langgraph-python`,
      framework: 'langgraph-python',
    }),
  ),
  ...['adk-js', 'adk-go'].flatMap((framework) =>
    langGraphSpecs.map(
      (spec): TemplateSpec => ({
        ...spec,
        name: `${spec.kind}-${framework}`,
        framework,
        steps: spec.steps.map((step) =>
          step.action === 'text' && step.name.startsWith('Correct. ')
            ? { ...step, name: step.name.slice('Correct. '.length) }
            : step,
        ),
      }),
    ),
  ),
];

function redactRequestPath(url: string): string {
  const { pathname } = new URL(url);
  if (
    pathname === '/' ||
    pathname === '/favicon.ico' ||
    pathname === '/api/session' ||
    pathname === '/api/v1/chat/completions' ||
    pathname === '/go/agent.wasm' ||
    pathname === '/python/runtime/pyodide.asm.wasm'
  )
    return pathname;
  for (const prefix of ['/assets/', '/python/runtime/', '/python/wheels/', '/python/agent/'])
    if (pathname.startsWith(prefix)) return `${prefix}<file>`;
  return '<path redacted>';
}

export async function driveChromium(
  url: string,
  spec: TemplateSpec,
  signal?: AbortSignal,
): Promise<string> {
  const { chromium } = await import('playwright');
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({
      headless: true,
      handleSIGINT: false,
      handleSIGTERM: false,
      args: ['--disable-gpu', '--disable-webgpu'],
    });
  } catch {
    throw new Error('Chromium unavailable; run pnpm exec playwright install chromium.');
  }
  const abort = (): void => {
    void browser.close();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const origin = URL.parse(url)?.origin;
    const context = await browser.newContext({ serviceWorkers: 'block' });
    await context.addInitScript(
      "Object.defineProperty(globalThis, 'LanguageModel', { configurable: true, value: undefined }); Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });",
    );
    let external = 0;
    const errors: string[] = [];
    const requestErrors: string[] = [];
    const addError = (message: string): void => {
      if (errors.length < 16) errors.push(message);
    };
    let activity = 'navigation';
    const requests = new WeakMap<Request, { step: string; start: number }>();
    const requestError = (request: Request, reason: string): void => {
      if (requestErrors.length >= 16) return;
      const now = performance.now();
      const { step, start } = requests.get(request) ?? { step: activity, start: now };
      requestErrors.push(
        `Drive ${step}: ${redactRequestPath(request.url())} — ${reason} (${Math.round(now - start)} ms)`,
      );
    };
    let expected: Step['unavailable'];
    const responses = new Set<string>();
    const diagnostics = new Set<string>();
    const flush = async (): Promise<void> => {
      await page.evaluate(
        'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
      );
    };
    await context.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin !== origin) {
        external++;
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', () => addError('Page error.'));
    page.on('request', (request) => {
      requests.set(request, { step: activity, start: performance.now() });
    });
    page.on('requestfailed', (request) => {
      const code = request.failure()?.errorText ?? '';
      requestError(request, /^net::ERR_[A-Z0-9_]{1,48}$/.test(code) ? code : 'Request failed');
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status < 400) return;
      if (expected !== undefined && status === 503) {
        const target = new URL(response.url());
        if (target.origin === origin && target.pathname === expected.path) {
          responses.add(response.url());
          return;
        }
      }
      requestError(response.request(), `HTTP status ${status}`);
    });
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (
        expected !== undefined &&
        /^Failed to load resource: the server responded with a status of 503(?: \(Service Unavailable\))?$/.test(
          message.text(),
        )
      ) {
        diagnostics.add(message.location().url);
        return;
      }
      // Fixed text: the page's message is not echoed, and the cause is named for the operator.
      addError(
        message.text().startsWith("This document requires 'TrustedScript' assignment.")
          ? 'Trusted Types probe: configure zod jitless before the application schemas.'
          : 'Console error.',
      );
    });
    try {
      const response = await page.goto(url);
      const navigated = response?.status() === 200;
      if (!navigated) {
        if (response !== null && response.status() < 400)
          requestError(response.request(), `HTTP status ${response.status()}`);
        addError('Page did not return 200.');
      }
      const steps = navigated ? spec.steps : [];
      for (const [index, step] of steps.entries()) {
        activity = `step ${index + 1} (${step.action})`;
        expected = step.unavailable;
        if (step.action === 'text') await page.getByText(step.name, { exact: true }).waitFor();
        else {
          if (step.role === undefined) {
            addError('Missing step role.');
            break;
          }
          const locator = page.getByRole(step.role, { name: step.name, exact: true });
          if (step.action === 'check') await locator.check();
          else if (step.action === 'click') await locator.click();
          else await locator.waitFor();
        }
        if (expected !== undefined) {
          await page.getByText(expected.text, { exact: true }).waitFor();
          await flush();
          if (responses.size === 0) addError('Expected HTTP status 503 was not observed.');
          for (const diagnostic of diagnostics)
            if (!responses.has(diagnostic))
              addError('Console error: uncorrelated HTTP status 503.');
          responses.clear();
          diagnostics.clear();
        }
        expected = undefined;
      }
      await flush();
    } catch {
      // Playwright errors can include complete URLs, selectors or page content.
      signal?.throwIfAborted();
      addError(`Drive ${activity} failed.`);
    }
    if (external > 0) requestErrors.unshift(`Cross-origin request attempts: ${external}.`);
    if (requestErrors.length > 0 || errors.length > 0)
      throw new Error([...requestErrors, ...errors].join('\n'));
    return browser.version();
  } finally {
    signal?.removeEventListener('abort', abort);
    await browser.close();
  }
}

export function renderResults(results: readonly Result[]): string {
  return results
    .map(
      (result) =>
        `${result.template} | ${result.node} | ${result.packageManager} ${result.packageManagerVersion} | ${result.mode} | ${result.failures.some((failure) => failure.gating || failure.source === 'unclassified') ? 'FAIL' : 'PASS'} | ${result.durationMs} ms${result.serverDurationMs === null ? '' : ` | server ${result.serverDurationMs} ms`} | release age ${result.releaseAgeDays}d${result.exclude === null ? '' : `; exclusion ${result.exclude}`}\n${result.failures.map((failure) => `  ${failure.phase} [${failure.source}]${failure.gating ? '' : ' (advisory)'}: ${failure.summary}\n${failure.excerpt}`).join('\n')}`,
    )
    .join('\n');
}

if (import.meta.main) {
  let options: Arguments | undefined;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : usage);
    process.exitCode = 2;
  }
  if (options?.help) console.info(usage);
  else if (options !== undefined) {
    try {
      // Native Node strips TypeScript but does not remap emitted .js specifiers to source .ts.
      const core = (await import(
        new URL('./standalone-core.ts', import.meta.url).href
      )) as typeof import('./standalone-core.js');
      const results = await core.runStandalone(
        {
          repo: fileURLToPath(new URL('..', import.meta.url)),
          nodes: options.nodes,
          modes: options.mode === 'both' ? ['registry', 'tarball'] : [options.mode],
          packageManager: options.packageManager,
          specs: templateSpecs.filter(
            (spec) =>
              spec.framework === options.framework &&
              (options.kind === 'all' || spec.kind === options.kind),
          ),
          ...(options.tarballs === undefined ? {} : { tarballs: options.tarballs }),
          ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
          keep: options.keep,
          cleanPath: options.cleanPath,
          budgetMinutes: options.budgetMinutes,
          serverBudgetMinutes: options.serverBudgetMinutes,
        },
        {
          scaffold: async ({ spec, directory, tarballs, node, env, signal, runner }) => {
            await runner.run({
              executable: node,
              args: [
                fileURLToPath(new URL('../packages/create/dist/cli.js', import.meta.url)),
                basename(directory),
                '--kind',
                spec.kind,
                '--framework',
                spec.framework,
                '--no-install',
              ],
              cwd: dirname(directory),
              env: {
                ...env,
                ...(tarballs === undefined ? {} : { GALAXIE_CREATE_PACKAGE_DIR: tarballs }),
              },
              signal,
            });
          },
          driver: { drive: driveChromium },
          retained: (path) => console.info(`Retained temporary root: ${path}`),
        },
      );
      console.info(renderResults(results));
      if (options.mode === 'both')
        for (const spec of new Set(results.map((result) => result.template)))
          for (const node of options.nodes) {
            const matched = results.filter(
              (result) =>
                result.template === spec &&
                Number(result.node.replace(/^v/, '').split('.')[0]) === node.major,
            );
            const failed = (mode: Mode): boolean =>
              matched.some((result) => result.mode === mode && result.failures.length > 0);
            console.info(
              `${spec} | Node ${node.major} | ${core.compareModes(failed('registry'), failed('tarball'))}`,
            );
          }
      if (options.json !== undefined)
        await writeFile(options.json, `${JSON.stringify(results, null, 2)}\n`);
      if (
        results.some((result) =>
          result.failures.some((failure) => failure.gating || failure.source === 'unclassified'),
        )
      )
        process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : 'Standalone verification failed.');
      process.exitCode = 1;
    }
  }
}
