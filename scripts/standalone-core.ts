// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
  access,
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse } from 'yaml';
import type { PackageManager } from '../packages/create/src/packages.js';

export const launchPackages: readonly string[] = [
  'ui-protocol',
  'core',
  'adapter-kit',
  'adapter-langgraph',
  'models',
  'storage-indexeddb',
  'react',
].map((name) => `@galaxie-ai/${name}`);
export type Mode = 'registry' | 'tarball';
export type Phase =
  | 'node'
  | 'pack'
  | 'scaffold'
  | 'install'
  | 'build'
  | 'check'
  | 'negative-control'
  | 'compile'
  | 'serve'
  | 'drive'
  | 'probe'
  | 'budget';
export interface Failure {
  readonly phase: Phase;
  readonly gating: boolean;
  readonly source: string;
  readonly suggested: true;
  readonly summary: string;
  readonly excerpt: string;
}
export interface Result {
  readonly template: string;
  node: string;
  readonly packageManager: PackageManager;
  packageManagerVersion: string;
  npm?: string;
  readonly mode: Mode;
  readonly releaseAgeDays: number;
  readonly exclude: string | null;
  browser: string | null;
  durationMs: number;
  serverDurationMs: number | null;
  readonly failures: Failure[];
}
export interface Step {
  readonly action: 'check' | 'click' | 'text' | 'visible';
  readonly role?: 'radio' | 'button';
  readonly name: string;
  readonly unavailable?: { readonly path: string; readonly text: string };
}
export interface TemplateSpec {
  readonly name: string;
  readonly kind: string;
  readonly framework: string;
  readonly build: readonly string[];
  readonly preview: readonly string[];
  readonly steps: readonly Step[];
  readonly probeSession?: boolean;
  readonly server?: {
    readonly compile: readonly string[];
    readonly entry: string;
    readonly port: number;
    readonly steps?: readonly Step[];
  };
}
export interface Driver {
  drive(url: string, spec: TemplateSpec, signal?: AbortSignal): Promise<string>;
}
export interface Command {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}
export interface Child {
  stop(): Promise<void>;
  output(): string;
}
export interface Runner {
  run(command: Command): Promise<string>;
  start(command: Command): Promise<Child>;
}
export interface Clock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}
export interface PortFinder {
  find(preferred?: number): Promise<number>;
}
export interface NodeRequest {
  readonly major: number;
  readonly path?: string;
}
export interface Options {
  readonly repo: string;
  readonly tempBase?: string;
  readonly nodes: readonly NodeRequest[];
  readonly modes: readonly Mode[];
  readonly packageManager?: PackageManager;
  readonly specs: readonly TemplateSpec[];
  readonly tarballs?: string;
  readonly keep?: boolean;
  readonly exclude?: string;
  readonly signal?: AbortSignal;
  readonly offline?: boolean;
  readonly verifyReleaseAge?: boolean;
  readonly cleanPath?: boolean;
  readonly budgetMinutes?: number;
  readonly serverBudgetMinutes?: number;
}
export interface ScaffoldRequest {
  readonly spec: TemplateSpec;
  readonly mode: Mode;
  readonly directory: string;
  readonly tarballs?: string;
  readonly node: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly runner: Runner;
}
export interface Dependencies {
  readonly scaffold: (request: ScaffoldRequest) => Promise<void>;
  readonly driver: Driver;
  readonly runner?: Runner;
  readonly clock?: Clock;
  readonly ports?: PortFinder;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly retained?: (path: string) => void;
}

function releaseAgeMinutes(source: string): number {
  const values = [...source.matchAll(/^minimumReleaseAge:\s*(\d+)\s*(?:#.*)?$/gm)];
  const minutes = Number(values[0]?.[1]);
  if (values.length !== 1 || !Number.isSafeInteger(minutes) || minutes <= 0)
    throw new Error('Invalid minimumReleaseAge policy.');
  return minutes;
}

export function releaseAgeDays(source: string): number {
  return Math.ceil(releaseAgeMinutes(source) / 1440);
}

export function isolatedEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  root: string,
  days: number,
  exclude?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'CI']) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, {
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_userconfig: join(root, 'user.npmrc'),
    npm_config_globalconfig: join(root, 'global.npmrc'),
    npm_config_cache: join(root, 'cache'),
    npm_config_min_release_age: String(days),
  });
  if (exclude !== undefined) env['npm_config_min_release_age_exclude'] = exclude;
  return env;
}

export async function nodeBinary(
  request: NodeRequest,
  current: { major: number; path: string },
  nvm?: string,
): Promise<string> {
  if (request.path !== undefined) return resolve(request.path);
  if (request.major === current.major) return current.path;
  if (nvm !== undefined) {
    const directory = join(nvm, 'versions/node');
    const versions = await readdir(directory).catch(() => [] as string[]);
    const matches = versions.filter((name) =>
      new RegExp(`^v${request.major}\\.\\d+\\.\\d+$`).test(name),
    );
    matches.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of matches) {
      const binary = join(directory, version, 'bin/node');
      if ((await lstat(binary).catch(() => undefined))?.isFile()) return binary;
    }
  }
  throw new Error(`Node unavailable; run nvm install ${request.major}.`);
}

interface Manifest {
  readonly dependencies?: Record<string, string>;
}

function allowedTarball(name: string, framework: string): boolean {
  return (
    launchPackages.includes(name) ||
    (framework === 'adk-js' && name === '@galaxie-ai/adapter-adk') ||
    (framework === 'adk-go' &&
      ['@galaxie-ai/adapter-go', '@galaxie-ai/starter-go'].includes(name)) ||
    (framework === 'langgraph-python' &&
      ['@galaxie-ai/adapter-pyodide', '@galaxie-ai/starter-python'].includes(name))
  );
}

export function assertSingleCopies(
  lock: { packages?: Record<string, { resolved?: string }> },
  required: readonly string[],
  framework = 'langgraph-js',
): void {
  const counts = new Map<string, number>();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const name = /(?:^|\/)node_modules\/(@galaxie-ai\/[^/]+)$/.exec(path)?.[1];
    if (name === undefined) continue;
    if (!allowedTarball(name, framework) || !entry.resolved?.startsWith('file:'))
      throw new Error(`Single-copy tarball check failed for ${name}.`);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const name of new Set([...required, ...counts.keys()]))
    if (counts.get(name) !== 1) throw new Error(`Single-copy tarball check failed for ${name}.`);
}

function lockRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Single-copy tarball check failed: expected a lockfile mapping.');
  return value as Record<string, unknown>;
}

const lockPackageName = /^(@galaxie-ai\/[^@\s]+)@/;
const lockfileNames = { pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock' } as const;

/** Check the file locators and digests recorded by the pinned pnpm and Yarn releases. */
export async function assertManagedTarballs(
  manager: 'pnpm' | 'yarn',
  source: string,
  project: string,
  archives: ReadonlyMap<string, string>,
  required: readonly string[],
): Promise<void> {
  const lock = lockRecord(parse(source, { maxAliasCount: 0 }));
  if (manager === 'pnpm' && lock['lockfileVersion'] !== '9.0')
    throw new Error('Single-copy tarball check failed: expected pnpm lockfile version 9.0.');
  if (manager === 'yarn' && lockRecord(lock['__metadata'])['version'] !== 10)
    throw new Error('Single-copy tarball check failed: expected Yarn lockfile version 10.');
  const packages = manager === 'pnpm' ? lockRecord(lock['packages']) : lock;
  const snapshots = manager === 'pnpm' ? Object.keys(lockRecord(lock['snapshots'])) : [];
  const seen = new Set<string>();
  const mismatch = (name: string): Error =>
    new Error(`Single-copy tarball check failed for ${name}.`);
  for (const [key, entry] of Object.entries(packages)) {
    const yarnResolution = manager === 'yarn' ? lockRecord(entry)['resolution'] : undefined;
    const name =
      lockPackageName.exec(key)?.[1] ??
      (typeof yarnResolution === 'string' ? lockPackageName.exec(yarnResolution)?.[1] : undefined);
    if (name === undefined) continue;
    const path = archives.get(name);
    if (path === undefined || seen.has(name)) throw mismatch(name);
    seen.add(name);
    const record = lockRecord(entry);
    const hash = createHash('sha512');
    for await (const bytes of createReadStream(path)) hash.update(bytes as Buffer);
    if (manager === 'pnpm') {
      const resolution = lockRecord(record['resolution']);
      const tarball = resolution['tarball'];
      const reference = key.slice(name.length + 1);
      if (
        typeof tarball !== 'string' ||
        !tarball.startsWith('file:') ||
        tarball !== reference ||
        resolve(project, tarball.slice('file:'.length)) !== path ||
        resolution['integrity'] !== `sha512-${hash.digest('base64')}` ||
        snapshots.filter((snapshot) => lockPackageName.exec(snapshot)?.[1] === name).length !== 1 ||
        !snapshots.some((snapshot) => snapshot === key || snapshot.startsWith(`${key}(`))
      )
        throw mismatch(name);
    } else {
      const prefix = `${name}@file:${path}#${path}::`;
      const checksum = record['checksum'];
      // Yarn's locator records a short hash of the .tgz. Its full checksum covers the cache zip.
      if (
        typeof yarnResolution !== 'string' ||
        !yarnResolution.startsWith(prefix) ||
        new URLSearchParams(yarnResolution.slice(prefix.length)).get('hash') !==
          hash.digest('hex').slice(0, 6) ||
        typeof checksum !== 'string' ||
        !/^[a-f0-9]+\/[a-f0-9]{128}$/i.test(checksum)
      )
        throw mismatch(name);
    }
  }
  for (const snapshot of snapshots) {
    const name = lockPackageName.exec(snapshot)?.[1];
    if (name !== undefined && !seen.has(name)) throw mismatch(name);
  }
  for (const name of required) if (!seen.has(name)) throw mismatch(name);
}

const stripped = new Set([
  'node_modules',
  'dist',
  '.server',
  'test',
  'tsconfig.workspace.json',
  '.npmrc',
  '.git',
]);
const strippedPrefix = '.env';
export async function assertCopy(directory: string): Promise<void> {
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error('Scaffold symlinks are not supported.');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (stripped.has(entry.name) || entry.name.startsWith(strippedPrefix))
      throw new Error('Workspace artifact survived the scaffold.');
    if (entry.isSymbolicLink()) throw new Error('Scaffold symlinks are not supported.');
    if (entry.isDirectory()) await assertCopy(join(directory, entry.name));
  }
}
export function assertOutside(repo: string, candidate: string): void {
  const path = relative(resolve(repo), resolve(candidate));
  if (path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)))
    throw new Error('Temporary projects must be outside the repository.');
}
export function assertCommand(
  executable: string,
  args: readonly string[],
  allowed: readonly string[],
): void {
  if (!allowed.includes(executable) || args.some((arg) => arg.includes('publish')))
    throw new Error('Command is not allowed.');
}
export function classify(message: string): string {
  const packageName =
    /node_modules\/@galaxie-ai\/([\w-]+)/.exec(message)?.[1] ??
    /(?:E404|404|ERESOLVE|peer)[\s\S]*?@galaxie-ai\/([\w-]+)/i.exec(message)?.[1];
  if (packageName !== undefined) return `package:${packageName}`;
  if (
    /EADDRINUSE|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network|release.age|Node unavailable|Node version|npm version|Chromium|browserType\.launch|Executable doesn't exist/i.test(
      message,
    )
  )
    return 'environment';
  if (
    /(?:^|[\s/])(?:src\/|server\/|check\/|vite\.config\.ts)|Cannot find (?:package|module)|typescript\/bin\/tsc/i.test(
      message,
    )
  )
    return 'template';
  if (
    /Single-copy|Workspace artifact|Scaffold symlinks|Negative control|Clean PATH|Command is not allowed|Temporary projects/.test(
      message,
    )
  )
    return 'harness';
  return 'unclassified';
}
export function redact(message: string, temp: string, home: string, lines = 16): string {
  let result = message.replaceAll(temp, '<temp>');
  if (home !== '') result = result.replaceAll(home, '<home>');
  return result
    .replace(/(?:https?|wss?):\/\/[^\s)'"<>]+/gi, '<url>')
    .replace(
      /(?:authorization|cookie|[\w-]*(?:token|password|secret|api[_-]?key))["']?\s*[:=]\s*[^\r\n]+/gi,
      '<redacted>',
    )
    .split(/\r?\n/)
    .slice(0, lines)
    .join('\n')
    .slice(0, 4000);
}
export function compareModes(
  registryFailed: boolean,
  tarballFailed: boolean,
): 'release-gap' | 'defect' | 'workspace-regression' | 'pass' {
  return registryFailed
    ? tarballFailed
      ? 'defect'
      : 'release-gap'
    : tarballFailed
      ? 'workspace-regression'
      : 'pass';
}

export async function findOnPath(name: string, path: string): Promise<string | undefined> {
  for (const directory of path.split(delimiter)) {
    const candidate = resolve(directory, name);
    if (!(await stat(candidate).catch(() => undefined))?.isFile()) continue;
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return undefined;
}

async function executableOnPath(name: string, path: string): Promise<string> {
  const candidate = await findOnPath(name, path);
  if (candidate !== undefined) return realpath(candidate);
  throw new Error(`Required executable unavailable: ${name}.`);
}

const forbiddenTools = ['go', 'python', 'python3', 'uv'];
export async function assertCleanPath(path: string): Promise<void> {
  for (const name of forbiddenTools) {
    const found = await findOnPath(name, path);
    if (found !== undefined)
      throw new Error(`Clean PATH violated: ${name} found at ${dirname(found)}`);
  }
}

const cleanPathProbe = `const { spawnSync } = require('node:child_process');
for (const name of ${JSON.stringify(forbiddenTools)}) {
  const result = spawnSync(name, ['--version'], { stdio: 'ignore', timeout: 1000 });
  if (result.error?.code !== 'ENOENT')
    throw new Error('Clean PATH violated: ' + name + ' did not fail with ENOENT.');
}`;

/** Spawn without a shell; terminate the entire child process group, including npm lifecycle children. */
export function processRunner(allowed: readonly string[]): Runner {
  const start = async (command: Command): Promise<Child & { completion: Promise<string> }> => {
    assertCommand(command.executable, command.args, allowed);
    command.signal.throwIfAborted();
    const child = spawn(command.executable, [...command.args], {
      cwd: command.cwd,
      env: command.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    const collect = (bytes: Buffer): void => {
      output = (output + bytes.toString()).slice(-64_000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const groupAlive = (): boolean => {
      if (child.pid === undefined) return false;
      if (process.platform === 'win32') return child.exitCode === null && child.signalCode === null;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const kill = (signal: NodeJS.Signals): void => {
      if (!groupAlive() || child.pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        /* The process group may already have exited. */
      }
    };
    const completion = new Promise<string>((fulfill, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        command.signal.removeEventListener('abort', abort);
        if (code === 0) fulfill(output);
        else reject(new Error(output || 'Child process failed.'));
      });
    });
    // Servers are observed through readiness and output, so early exit must not be unhandled.
    void completion.catch(() => {});
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopping ??= (async () => {
        kill('SIGTERM');
        const force = Promise.withResolvers<void>();
        const timer = setTimeout(() => {
          kill('SIGKILL');
          force.resolve();
        }, 2000);
        try {
          await completion.catch(() => {});
          if (groupAlive()) await force.promise;
        } finally {
          clearTimeout(timer);
        }
      })();
      return stopping;
    };
    const abort = (): void => {
      void stop();
    };
    command.signal.addEventListener('abort', abort, { once: true });
    return {
      completion,
      output: () => output,
      stop,
    };
  };
  return {
    start,
    run: async (command) => {
      const child = await start(command);
      const timer = setTimeout(() => {
        void child.stop();
      }, 300_000);
      try {
        return await child.completion;
      } finally {
        clearTimeout(timer);
        await child.stop();
      }
    },
  };
}

const systemClock: Clock = {
  now: Date.now,
  sleep,
};

const yarnPin = 'yarn@4.18.1';

async function packageManagerInvocation(
  manager: PackageManager,
  repo: string,
  path: string,
): Promise<{ prefix: readonly [string, ...string[]]; version?: string }> {
  if (manager === 'npm') return { prefix: [await executableOnPath('npm', path)] };
  let pin = yarnPin;
  if (manager === 'pnpm') {
    const workspace = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')) as {
      packageManager?: string;
    };
    if (
      workspace.packageManager === undefined ||
      !/^pnpm@11\.\d+\.\d+$/.test(workspace.packageManager)
    )
      throw new Error('Expected a pinned pnpm 11 version.');
    pin = workspace.packageManager;
  }
  const version = pin.slice(manager.length + 1);
  return { prefix: [await executableOnPath('corepack', path), pin], version };
}

async function installProject(
  manager: PackageManager,
  run: (args: readonly string[]) => Promise<string>,
  project: string,
  minutes: number,
  options: Options,
): Promise<void> {
  if (manager === 'npm') {
    if (options.verifyReleaseAge !== false) {
      const effective = (await run(['config', 'get', 'min-release-age'])).trim();
      if (effective !== String(Math.ceil(minutes / 1440)))
        throw new Error('npm release-age policy did not take effect.');
    }
    await run([
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...(options.offline ? ['--offline'] : []),
    ]);
  } else if (manager === 'pnpm') {
    await appendFile(
      join(project, 'pnpm-workspace.yaml'),
      `minimumReleaseAge: ${minutes}\nminimumReleaseAgeStrict: true\nminimumReleaseAgeIgnoreMissingTime: false\n` +
        // pnpm's shell bin wrappers need system utilities outside the clean PATH.
        (options.cleanPath ? 'preferSymlinkedExecutables: true\n' : ''),
    );
    const effective = (await run(['config', 'get', 'minimumReleaseAge'])).trim();
    const strict = (await run(['config', 'get', 'minimumReleaseAgeStrict'])).trim();
    const requiresTime = (
      await run(['config', 'get', 'minimumReleaseAgeIgnoreMissingTime'])
    ).trim();
    if (effective !== String(minutes) || strict !== 'true' || requiresTime !== 'false')
      throw new Error('pnpm release-age policy did not take effect.');
    await run([
      'install',
      '--ignore-scripts',
      '--no-frozen-lockfile',
      ...(options.offline ? ['--offline'] : []),
    ]);
    await run(['install', '--ignore-scripts', '--frozen-lockfile', '--offline']);
  } else {
    await appendFile(
      join(project, '.yarnrc.yml'),
      `npmMinimalAgeGate: ${minutes}m\nchecksumBehavior: throw\n`,
    );
    const effective = (await run(['config', 'get', 'npmMinimalAgeGate', '--json'])).trim();
    if (effective !== String(minutes))
      throw new Error('Yarn release-age policy did not take effect.');
    await run(['install', '--mode=skip-build']);
    await run([
      'install',
      '--mode=skip-build',
      '--immutable',
      ...(options.offline ? ['--immutable-cache'] : ['--check-cache']),
    ]);
  }
}
const loopbackPorts: PortFinder = {
  find: (preferred = 0) =>
    new Promise((fulfill, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(preferred, '127.0.0.1', () => {
        const address = server.address();
        server.close((error) => {
          if (error !== undefined) reject(error);
          else if (address === null || typeof address === 'string')
            reject(new Error('No loopback port.'));
          else fulfill(address.port);
        });
      });
    }),
};

async function ready(url: string, signal: AbortSignal, clock: Clock, child: Child): Promise<void> {
  const deadline = clock.now() + 30_000;
  while (clock.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      signal.throwIfAborted();
    }
    await clock.sleep(100);
  }
  throw new Error(`Server readiness timed out.\n${child.output()}`);
}

async function assertBaselineRejections(
  project: string,
  check: () => Promise<string>,
  signal: AbortSignal,
): Promise<void> {
  const path = join(project, 'src/csp.ts');
  const original = await readFile(path, 'utf8');
  const mutations = [
    {
      directive: 'script-src',
      change: (source: string): string =>
        source.replace(
          /('script-src':\s*)([^\n]+)/,
          (_match, prefix: string, value: string) =>
            prefix + value.replaceAll('[', '["\'unsafe-inline\'", '),
        ),
    },
    {
      directive: 'require-trusted-types-for',
      change: (source: string): string =>
        source.replace(/('require-trusted-types-for':\s*)\[[^\]]*\]/, '$1[]'),
    },
  ];
  for (const { directive, change } of mutations) {
    signal.throwIfAborted();
    const changed = change(original);
    if (changed === original) throw new Error(`Negative control could not mutate ${directive}.`);
    try {
      await writeFile(path, changed);
      let rejected = false;
      try {
        await check();
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof Error) || !error.message.includes(`${directive} changed`))
          throw new Error(
            `Negative control did not report ${directive} changed.\n${error instanceof Error ? error.message : 'Unknown check failure.'}`,
          );
        rejected = true;
      }
      if (!rejected) throw new Error(`Negative control unexpectedly passed for ${directive}.`);
    } finally {
      await writeFile(path, original);
    }
  }
}

async function assertGoSourceRejection(
  project: string,
  build: () => Promise<string>,
  signal: AbortSignal,
): Promise<void> {
  const path = join(project, 'go/agent.go');
  const original = await readFile(path);
  const expected =
    'The agent source in go/ was edited and Go 1.27.3 was not found on PATH. Install Go 1.27.3, or restore the original go/ source to use the prebuilt agent.';
  signal.throwIfAborted();
  try {
    await writeFile(
      path,
      Buffer.concat([original, Buffer.from('\n// Standalone no-Go negative control.\n')]),
    );
    let rejected = false;
    try {
      await build();
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof Error) || !error.message.includes(expected))
        throw new Error(
          `Negative control did not report ${expected}.\n${error instanceof Error ? error.message : 'Unknown build failure.'}`,
        );
      rejected = true;
    }
    if (!rejected) throw new Error('Negative control unexpectedly passed for edited Go source.');
  } finally {
    await writeFile(path, original);
  }
  signal.throwIfAborted();
  await build();
}

function checkBudget(result: Result, durationMs: number, minutes: number, label: string): void {
  const allowedMs = minutes * 60_000;
  if (durationMs > allowedMs)
    result.failures.push({
      phase: 'budget',
      gating: true,
      source: 'harness',
      suggested: true,
      summary: `${label} exceeded: ${durationMs} ms of ${allowedMs} ms`,
      excerpt: '',
    });
}

/** One owned temporary root, one pipeline for registry and packed installations. */
export async function runStandalone(
  options: Options,
  dependencies: Dependencies,
): Promise<Result[]> {
  const manager = options.packageManager ?? 'npm';
  if (
    manager !== 'npm' &&
    (options.modes.some((mode) => mode !== 'tarball') || options.exclude !== undefined)
  )
    throw new Error(
      'pnpm and Yarn verification require tarball mode without release-age exclusions.',
    );
  const environment = dependencies.environment ?? process.env;
  const repo = await realpath(options.repo);
  const base = await realpath(options.tempBase ?? tmpdir());
  assertOutside(repo, base);
  const root = await mkdtemp(join(base, 'galaxie-standalone-'));
  const controller = new AbortController();
  const signal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal]);
  const interrupt = (): void => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const results: Result[] = [];
  const children = new Set<Child>();
  const clock = dependencies.clock ?? systemClock;
  const ports = dependencies.ports ?? loopbackPorts;
  try {
    const minutes = releaseAgeMinutes(await readFile(join(repo, 'pnpm-workspace.yaml'), 'utf8'));
    const days = Math.ceil(minutes / 1440);
    await writeFile(join(root, 'user.npmrc'), '');
    await writeFile(join(root, 'global.npmrc'), '');
    const env = isolatedEnvironment(environment, root, days, options.exclude);
    const { prefix, version } = await packageManagerInvocation(manager, repo, env['PATH'] ?? '');
    const managerEnv = { ...env };
    if (manager !== 'npm') {
      managerEnv['HOME'] = join(root, 'home');
      if (options.offline) managerEnv['COREPACK_ENABLE_NETWORK'] = '0';
      if (manager === 'yarn') {
        managerEnv['YARN_ENABLE_IMMUTABLE_INSTALLS'] = 'false';
        managerEnv['YARN_NPM_REGISTRY_SERVER'] = 'https://registry.npmjs.org';
        if (options.offline) managerEnv['YARN_ENABLE_NETWORK'] = 'false';
      }
    }
    const pnpm =
      options.modes.includes('tarball') && options.tarballs === undefined
        ? await executableOnPath('pnpm', environment['PATH'] ?? '')
        : undefined;
    const binaries = new Map<number, string | Error>();
    const cleanPaths = new Map<number, string>();
    for (const request of options.nodes) {
      try {
        const binary = await nodeBinary(
          request,
          { major: Number(process.versions.node.split('.')[0]), path: process.execPath },
          environment['NVM_DIR'] ??
            (environment['HOME'] === undefined ? undefined : join(environment['HOME'], '.nvm')),
        );
        if (options.cleanPath) {
          const bin = join(root, `bin-${request.major}`);
          await mkdir(bin);
          await symlink(binary, join(bin, 'node'));
          await symlink(await executableOnPath('sh', environment['PATH'] ?? ''), join(bin, 'sh'));
          cleanPaths.set(request.major, bin);
        }
        binaries.set(request.major, binary);
      } catch (error) {
        binaries.set(
          request.major,
          error instanceof Error ? error : new Error('Node unavailable.'),
        );
      }
    }
    const runner =
      dependencies.runner ??
      processRunner([
        process.execPath,
        prefix[0],
        ...(pnpm === undefined ? [] : [pnpm]),
        ...[...binaries.values()].filter((value): value is string => typeof value === 'string'),
      ]);
    const command = (
      executable: string,
      args: readonly string[],
      cwd: string,
      childEnv = env,
    ): Command => ({ executable, args, cwd, env: childEnv, signal });
    const needsAdk = options.specs.some((spec) => spec.framework === 'adk-js');
    const needsGo = options.specs.some((spec) => spec.framework === 'adk-go');
    const needsPython = options.specs.some((spec) => spec.framework === 'langgraph-python');
    const packedPackages = [
      ...launchPackages,
      ...(needsAdk ? ['@galaxie-ai/adapter-adk'] : []),
      ...(needsGo ? ['@galaxie-ai/adapter-go', '@galaxie-ai/starter-go'] : []),
      ...(needsPython ? ['@galaxie-ai/adapter-pyodide', '@galaxie-ai/starter-python'] : []),
    ];
    let tarballs: string | undefined;
    const archives = new Map<string, string>();
    let packError: unknown;
    if (options.modes.includes('tarball')) {
      try {
        const destination = join(root, 'tarballs');
        await mkdir(destination);
        if (options.tarballs !== undefined) {
          await cp(await realpath(options.tarballs), destination, { recursive: true });
        } else {
          if (pnpm === undefined) throw new Error('Packing is impossible: pnpm unavailable.');
          await runner.run(command(pnpm, ['run', 'build:packages'], repo));
          if (needsAdk)
            await runner.run(
              command(
                pnpm,
                ['exec', 'tsc', '-p', 'packages/adapter-adk/tsconfig.build.json'],
                repo,
              ),
            );
          if (needsGo)
            await runner.run(
              command(pnpm, ['exec', 'tsc', '-p', 'packages/adapter-go/tsconfig.build.json'], repo),
            );
          if (needsPython)
            await runner.run(
              command(
                pnpm,
                ['exec', 'tsc', '-p', 'packages/adapter-pyodide/tsconfig.build.json'],
                repo,
              ),
            );
          for (const name of packedPackages)
            await runner.run(
              command(
                pnpm,
                ['pack', '--pack-destination', destination],
                join(repo, 'packages', name.split('/')[1] ?? ''),
              ),
            );
        }
        const filenames = await readdir(destination);
        for (const name of packedPackages) {
          const matches = filenames.filter(
            (file) => file.startsWith(`galaxie-ai-${name.split('/')[1]}-`) && file.endsWith('.tgz'),
          );
          if (matches.length !== 1)
            throw new Error(`Packing is impossible: expected one tarball for ${name}.`);
          archives.set(name, join(destination, matches[0] as string));
        }
        tarballs = destination;
      } catch (error) {
        packError = error;
      }
    }
    for (const request of options.nodes)
      for (const spec of options.specs)
        for (const mode of options.modes) {
          const result: Result = {
            template: spec.name,
            node: String(request.major),
            packageManager: manager,
            packageManagerVersion: 'unknown',
            ...(manager === 'npm' ? { npm: 'unknown' } : {}),
            mode,
            releaseAgeDays: days,
            exclude: options.exclude ?? null,
            browser: null,
            durationMs: 0,
            serverDurationMs: null,
            failures: [],
          };
          results.push(result);
          let phase: Phase = 'node';
          let started: number | undefined;
          let finished: number | undefined;
          let serverStarted: number | undefined;
          let serverFinished: number | undefined;
          let excludedDurationMs = 0;
          const finishLeg = (): void => {
            if (serverStarted !== undefined) serverFinished ??= clock.now();
            else if (started !== undefined) finished ??= clock.now();
          };
          const record = (error: unknown): void => {
            finishLeg();
            const message = error instanceof Error ? error.message : 'Unknown failure.';
            result.failures.push({
              phase,
              gating: true,
              source: classify(message),
              suggested: true,
              summary: `${phase} failed.`,
              excerpt: redact(message, root, environment['HOME'] ?? ''),
            });
          };
          try {
            signal.throwIfAborted();
            const binary = binaries.get(request.major);
            if (binary instanceof Error) throw binary;
            if (binary === undefined) throw new Error('Node unavailable.');
            const childEnv = {
              ...managerEnv,
              PATH:
                cleanPaths.get(request.major) ??
                `${dirname(binary)}${delimiter}${env['PATH'] ?? ''}`,
            };
            const run = (args: readonly string[]): Promise<string> =>
              runner.run(command(binary, args, project, childEnv));
            const manage = (args: readonly string[]): Promise<string> => run([...prefix, ...args]);
            const project = join(root, `${spec.name}-${request.major}-${mode}`);
            const observedNode = (
              await runner.run(command(binary, ['--version'], root, childEnv))
            ).trim();
            if (Number(observedNode.replace(/^v/, '').split('.')[0]) !== request.major)
              throw new Error('Node version does not match requested major.');
            result.node = observedNode;
            result.packageManagerVersion = (
              await runner.run(command(binary, [...prefix, '--version'], root, childEnv))
            ).trim();
            if (manager === 'npm') result.npm = result.packageManagerVersion;
            if (
              manager === 'npm' &&
              options.verifyReleaseAge !== false &&
              Number(result.packageManagerVersion.split('.')[0]) < 12
            )
              throw new Error('npm version 12 or later is required for release-age enforcement.');
            if (version !== undefined && result.packageManagerVersion !== version)
              throw new Error(`${manager} version does not match the pinned version ${version}.`);
            if (mode === 'tarball') {
              phase = 'pack';
              if (packError !== undefined) throw packError;
            }
            if (options.cleanPath) {
              phase = 'probe';
              await assertCleanPath(childEnv.PATH);
              await runner.run(command(binary, ['-e', cleanPathProbe], root, childEnv));
            }
            phase = 'scaffold';
            started = clock.now();
            await dependencies.scaffold({
              spec,
              mode,
              directory: project,
              node: binary,
              env:
                manager === 'npm'
                  ? childEnv
                  : {
                      ...childEnv,
                      npm_config_user_agent: `${manager}/${result.packageManagerVersion}`,
                    },
              signal,
              runner,
              ...(mode === 'tarball' && tarballs !== undefined ? { tarballs } : {}),
            });
            await assertCopy(project);
            const manifest = JSON.parse(
              await readFile(join(project, 'package.json'), 'utf8'),
            ) as Manifest;
            phase = 'install';
            await installProject(manager, manage, project, minutes, options);
            if (mode === 'tarball') {
              const required = [
                ...new Set([
                  '@galaxie-ai/core',
                  '@galaxie-ai/ui-protocol',
                  '@galaxie-ai/adapter-kit',
                  ...Object.keys(manifest.dependencies ?? {}).filter((name) =>
                    name.startsWith('@galaxie-ai/'),
                  ),
                ]),
              ];
              if (manager === 'npm') {
                assertSingleCopies(
                  JSON.parse(
                    await readFile(join(project, 'package-lock.json'), 'utf8'),
                  ) as Parameters<typeof assertSingleCopies>[0],
                  required,
                  spec.framework,
                );
              } else {
                await assertManagedTarballs(
                  manager,
                  await readFile(join(project, lockfileNames[manager]), 'utf8'),
                  project,
                  new Map([...archives].filter(([name]) => allowedTarball(name, spec.framework))),
                  required,
                );
              }
            }
            phase = 'build';
            await run(spec.build);
            if (options.cleanPath && spec.framework === 'adk-go') {
              phase = 'negative-control';
              const controlStarted = clock.now();
              try {
                await assertGoSourceRejection(project, () => run(spec.build), signal);
              } finally {
                excludedDurationMs += clock.now() - controlStarted;
              }
            }
            phase = 'check';
            await manage(['run', 'check']);
            phase = 'negative-control';
            await assertBaselineRejections(project, () => manage(['run', 'check']), signal);
            const serve = async (
              args: readonly string[],
              port: number,
              steps: readonly Step[] = spec.steps,
            ): Promise<void> => {
              phase = 'serve';
              const child = await runner.start(command(binary, args, project, childEnv));
              children.add(child);
              try {
                const url = `http://127.0.0.1:${port}`;
                await ready(url, signal, clock, child);
                if (spec.probeSession) {
                  phase = 'probe';
                  const response = await fetch(`${url}/api/session`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: '{"userId":"demo-ada"}',
                    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
                  });
                  // Never parse, print or store the token-bearing response body.
                  await response.body?.cancel();
                  if (response.status !== 200) throw new Error('Session probe did not return 200.');
                }
                phase = 'drive';
                result.browser = await dependencies.driver.drive(url, { ...spec, steps }, signal);
                finishLeg();
              } catch (error) {
                record(error);
              } finally {
                await child.stop();
                children.delete(child);
              }
            };
            phase = 'serve';
            const previewPort = await ports.find();
            await serve(
              [
                ...spec.preview,
                '--host',
                '127.0.0.1',
                '--port',
                String(previewPort),
                '--strictPort',
              ],
              previewPort,
            );
            if (spec.server !== undefined) {
              serverStarted = clock.now();
              phase = 'compile';
              await run(spec.server.compile);
              phase = 'serve';
              await ports.find(spec.server.port);
              await serve([spec.server.entry], spec.server.port, spec.server.steps ?? spec.steps);
            }
          } catch (error) {
            record(error);
          } finally {
            if (started !== undefined)
              result.durationMs = (finished ?? clock.now()) - started - excludedDurationMs;
            checkBudget(result, result.durationMs, options.budgetMinutes ?? 10, 'budget');
            if (serverStarted !== undefined) {
              result.serverDurationMs = (serverFinished ?? clock.now()) - serverStarted;
              checkBudget(
                result,
                result.serverDurationMs,
                options.serverBudgetMinutes ?? 2,
                'server budget',
              );
            }
          }
        }
    return results;
  } finally {
    controller.abort();
    for (const child of children) await child.stop();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (options.keep) dependencies.retained?.(root);
    else await rm(root, { recursive: true, force: true });
  }
}
