// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  Command,
  Result,
  ScaffoldRequest,
  Step,
  TemplateSpec,
} from '../../scripts/standalone-core.js';
import {
  assertCleanPath,
  assertCommand,
  assertCopy,
  assertOutside,
  assertSingleCopies,
  classify,
  compareModes,
  findOnPath,
  isolatedEnvironment,
  launchPackages,
  nodeBinary,
  processRunner,
  redact,
  releaseAgeDays,
  runStandalone,
} from '../../scripts/standalone-core.js';
import {
  driveChromium,
  parseArguments,
  renderResults,
  templateSpecs,
} from '../../scripts/verify-standalone.js';

const directories: string[] = [];
const fixtureSpec: TemplateSpec = {
  name: 'fixture',
  kind: 'browser-only',
  framework: 'langgraph-js',
  build: [],
  preview: [],
  steps: [],
};
const fixtureCsp = `'script-src': ["'self'"],\n'require-trusted-types-for': ["'script'"],\n`;
it('pins preview mock text to the gateway layer and keeps production unavailable', async () => {
  const gateway = templateSpecs[1];
  expect(gateway?.steps).toEqual([
    { action: 'click', role: 'button', name: 'Start with gateway' },
    { action: 'check', role: 'radio', name: '4' },
    { action: 'click', role: 'button', name: 'Submit answers' },
    { action: 'text', name: 'Correct. This is a fixed reply from the mock upstream.' },
    { action: 'text', name: 'Replies are fixed sample text from a mock upstream.' },
  ]);
  expect(gateway?.steps.some((step) => step.unavailable !== undefined)).toBe(false);
  expect(gateway?.server?.steps?.filter((step) => step.unavailable !== undefined)).toEqual([
    {
      action: 'click',
      role: 'button',
      name: 'Submit answers',
      unavailable: {
        path: '/api/v1/chat/completions',
        text: 'The gateway is unavailable. Retry later.',
      },
    },
  ]);
  const root = new URL('../../templates/kinds/gateway/files/', import.meta.url);
  expect(await readFile(new URL('server/mock-upstream.ts', root), 'utf8')).toContain(
    'This is a fixed reply from the mock upstream.',
  );
  expect(await readFile(new URL('src/gateway-state.ts', root), 'utf8')).toContain(
    'Replies are fixed sample text from a mock upstream.',
  );
});
async function writeBaseline(directory: string): Promise<void> {
  await mkdir(join(directory, 'src'), { recursive: true });
  await writeFile(join(directory, 'src/csp.ts'), fixtureCsp);
  const required = `'require-trusted-types-for': ["'script'"]`;
  await writeFile(
    join(directory, 'check.cjs'),
    `const source=require('node:fs').readFileSync('src/csp.ts','utf8');if(source.includes('unsafe-inline'))throw new Error('script-src changed');if(!source.includes(${JSON.stringify(required)}))throw new Error('require-trusted-types-for changed');`,
  );
  const path = join(directory, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(
    path,
    JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, check: 'node check.cjs' } }),
  );
}
function scaffoldFixture(source: string): (request: ScaffoldRequest) => Promise<void> {
  return async ({ directory }) => {
    await cp(source, directory, { recursive: true });
  };
}
async function unexpectedScaffold(): Promise<void> {
  throw new Error('Unexpected scaffold.');
}

const expectedLaunch = [
  '@galaxie-ai/ui-protocol',
  '@galaxie-ai/core',
  '@galaxie-ai/adapter-kit',
  '@galaxie-ai/adapter-langgraph',
  '@galaxie-ai/models',
  '@galaxie-ai/storage-indexeddb',
  '@galaxie-ai/react',
];
async function temporary(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'galaxie-harness-test-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it('allows only named environment fields and isolates npm configuration and cache', () => {
  const env = isolatedEnvironment(
    {
      PATH: '/bin',
      HOME: '/home/demo',
      LANG: 'C',
      CI: '1',
      TMPDIR: '/tmp',
      UPSTREAM_API_KEY: 'canary',
      NPM_TOKEN: 'canary',
      NODE_AUTH_TOKEN: 'canary',
      NODE_OPTIONS: '--inspect',
      npm_config_registry: 'canary',
    },
    '/tmp/check',
    7,
  );
  expect(env).toEqual({
    PATH: '/bin',
    HOME: '/home/demo',
    LANG: 'C',
    CI: '1',
    TMPDIR: '/tmp',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_userconfig: '/tmp/check/user.npmrc',
    npm_config_globalconfig: '/tmp/check/global.npmrc',
    npm_config_cache: '/tmp/check/cache',
    npm_config_min_release_age: '7',
  });
});

it('derives whole release-age days without a YAML parser and refuses absent or invalid policy', () => {
  expect(releaseAgeDays('minimumReleaseAge: 10080\n')).toBe(7);
  expect(releaseAgeDays('minimumReleaseAge: 10081 # minutes\n')).toBe(8);
  for (const source of [
    '',
    'minimumReleaseAge: wrong',
    'minimumReleaseAge: -1',
    'minimumReleaseAge: 1\nminimumReleaseAge: 2',
  ])
    expect(() => releaseAgeDays(source)).toThrow('minimumReleaseAge');
});

it('resolves explicit, current and newest nvm Nodes in that order with an actionable absence error', async () => {
  const nvm = await temporary();
  for (const version of ['22.3.0', '22.23.5']) {
    await mkdir(join(nvm, 'versions/node', `v${version}`, 'bin'), { recursive: true });
    await writeFile(join(nvm, 'versions/node', `v${version}`, 'bin/node'), '');
  }
  expect(
    await nodeBinary(
      { major: 22, path: '/explicit/node' },
      { major: 22, path: '/current/node' },
      nvm,
    ),
  ).toBe('/explicit/node');
  expect(await nodeBinary({ major: 22 }, { major: 22, path: '/current/node' }, nvm)).toBe(
    '/current/node',
  );
  expect(await nodeBinary({ major: 22 }, { major: 24, path: '/current/node' }, nvm)).toBe(
    join(nvm, 'versions/node/v22.23.5/bin/node'),
  );
  await expect(
    nodeBinary({ major: 26 }, { major: 24, path: '/current/node' }, nvm),
  ).rejects.toThrow('nvm install 26');
});

it('keeps the seven launch package inventory unchanged', () =>
  expect(launchPackages).toEqual(expectedLaunch));

it.each(['go', 'python', 'python3', 'uv'])(
  'rejects %s on a clean PATH and names its directory',
  async (name) => {
    const empty = await temporary();
    const tools = await temporary();
    await expect(assertCleanPath(empty)).resolves.toBeUndefined();
    expect(await findOnPath(name, empty)).toBeUndefined();
    await symlink(process.execPath, join(tools, name));
    const path = `${empty}${delimiter}${tools}`;
    expect(await findOnPath(name, path)).toBe(join(tools, name));
    await expect(assertCleanPath(path)).rejects.toThrow(
      `Clean PATH violated: ${name} found at ${tools}`,
    );
  },
);

it('PATH lookup skips non-executable files, directories and broken links', async () => {
  const root = await temporary();
  await writeFile(join(root, 'go'), '', { mode: 0o600 });
  await mkdir(join(root, 'python'));
  await symlink(join(root, 'missing'), join(root, 'uv'));
  await expect(assertCleanPath(root)).resolves.toBeUndefined();
});

it('detects nested duplicates, registry resolutions, absent dependencies and unrecognized galaxie packages', () => {
  const packages = Object.fromEntries(
    expectedLaunch.map((name) => [
      `node_modules/${name}`,
      { resolved: `file:/tmp/${name.split('/')[1]}.tgz` },
    ]),
  );
  expect(() => assertSingleCopies({ packages }, launchPackages)).not.toThrow();
  expect(() =>
    assertSingleCopies(
      {
        packages: {
          ...packages,
          'node_modules/x/node_modules/@galaxie-ai/core': { resolved: 'file:/tmp/core.tgz' },
        },
      },
      launchPackages,
    ),
  ).toThrow('Single-copy');
  expect(() =>
    assertSingleCopies(
      {
        packages: {
          ...packages,
          'node_modules/@galaxie-ai/core': { resolved: 'https://registry.npmjs.org/core' },
        },
      },
      launchPackages,
    ),
  ).toThrow('Single-copy');
  expect(() => assertSingleCopies({ packages: {} }, launchPackages)).toThrow('Single-copy');
  expect(() =>
    assertSingleCopies(
      {
        packages: {
          ...packages,
          'node_modules/@galaxie-ai/unknown': { resolved: 'file:/tmp/x.tgz' },
        },
      },
      launchPackages,
    ),
  ).toThrow('Single-copy');
});

it.each([
  'test',
  'tsconfig.workspace.json',
  'node_modules',
  'dist',
  '.server',
  '.npmrc',
  '.git',
  '.env',
  '.env.local',
])(
  'refuses a surviving workspace artifact (%s), with a clean scaffold control',
  async (artifact) => {
    const root = await temporary();
    const destination = join(root, 'project');
    await mkdir(destination);
    await writeFile(join(destination, 'package.json'), '{}');
    await assertCopy(destination);
    await writeFile(join(destination, artifact), 'canary');
    await expect(assertCopy(destination)).rejects.toThrow('Workspace artifact');
  },
);
it('requires temporary projects outside the repository', async () => {
  const root = await temporary();
  expect(() => assertOutside(join(root, 'repo'), join(root, 'repo/tmp'))).toThrow('outside');
  expect(() => assertOutside(join(root, 'repo'), join(root, 'repo'))).toThrow('outside');
  expect(() => assertOutside(join(root, 'repo'), join(root, 'repository'))).not.toThrow();
});

it('allows resolved tools and rejects other executables and publishing arguments', () => {
  expect(() => assertCommand('/bin/node', ['build.js'], ['/bin/node'])).not.toThrow();
  expect(() => assertCommand('/bin/sh', [], ['/bin/node'])).toThrow('Command');
  expect(() => assertCommand('/bin/node', ['npm-cli.js', 'publish'], ['/bin/node'])).toThrow(
    'Command',
  );
});

it.each([
  ['npm error E404 @galaxie-ai/tools-mcp', 'package:tools-mcp'],
  ['at node_modules/@galaxie-ai/react/dist/x.js:1', 'package:react'],
  ['at src/app.tsx:2', 'template'],
  ['EADDRINUSE', 'environment'],
  ['unknown failure', 'unclassified'],
])('suggests the source for %s', (message, expected) => expect(classify(message)).toBe(expected));

it('redacts local paths, credentials and URLs, and bounds excerpts by lines and bytes', () => {
  const output = redact(
    '/tmp/run/a /home/demo/x https://example.test/value\nauthorization: canary\nNPM_TOKEN=canary\nlast',
    '/tmp/run',
    '/home/demo',
    3,
  );
  expect(output).toContain('<temp>/a <home>/x <url>');
  expect(output).not.toContain('canary');
  expect(output.split('\n')).toHaveLength(3);
  expect(redact('x'.repeat(10000), '/tmp/run', '/home/demo').length).toBeLessThanOrEqual(4000);
});

it('compares matched failures across modes without treating advisory failures as passes', () => {
  expect(compareModes(true, false)).toBe('release-gap');
  expect(compareModes(true, true)).toBe('defect');
  expect(compareModes(false, true)).toBe('workspace-regression');
  expect(compareModes(false, false)).toBe('pass');
});

it('parses the documented CLI forms and refuses malformed or unknown arguments', () => {
  expect(
    parseArguments([
      '--node',
      '22=/p',
      '--node',
      '24',
      '--mode',
      'both',
      '--kind',
      'gateway',
      '--keep',
      '--clean-path',
      '--budget-minutes',
      '1',
    ]),
  ).toMatchObject({
    nodes: [{ major: 22, path: '/p' }, { major: 24 }],
    mode: 'both',
    kind: 'gateway',
    keep: true,
    cleanPath: true,
    budgetMinutes: 1,
  });
  expect(parseArguments([])).toMatchObject({ cleanPath: false, budgetMinutes: 10 });
  expect(parseArguments(['--help']).help).toBe(true);
  for (const args of [
    ['--wat'],
    ['--node'],
    ['--node', '22='],
    ['--kind', 'missing'],
    ['--template', 'local-only'],
    ['--mode', 'missing'],
    ['--budget-minutes'],
    ...['0', '61', 'x', '1.5', '-1', 'Infinity'].map((value) => ['--budget-minutes', value]),
  ])
    expect(() => parseArguments(args)).toThrow('Usage');
  expect(templateSpecs.map(({ name, kind, framework }) => ({ name, kind, framework }))).toEqual([
    { name: 'browser-only-langgraph-js', kind: 'browser-only', framework: 'langgraph-js' },
    { name: 'gateway-langgraph-js', kind: 'gateway', framework: 'langgraph-js' },
    { name: 'browser-only-langgraph-python', kind: 'browser-only', framework: 'langgraph-python' },
    { name: 'gateway-langgraph-python', kind: 'gateway', framework: 'langgraph-python' },
    { name: 'browser-only-adk-js', kind: 'browser-only', framework: 'adk-js' },
    { name: 'gateway-adk-js', kind: 'gateway', framework: 'adk-js' },
    { name: 'browser-only-adk-go', kind: 'browser-only', framework: 'adk-go' },
    { name: 'gateway-adk-go', kind: 'gateway', framework: 'adk-go' },
  ]);
  expect(templateSpecs[0]?.steps).toEqual([
    { action: 'check', role: 'radio', name: '4' },
    { action: 'click', role: 'button', name: 'Submit answers' },
    { action: 'text', name: 'Correct. Keep practicing one small step at a time.' },
  ]);
  expect(templateSpecs[1]).toMatchObject({
    probeSession: true,
    server: { entry: '.server/server/serve.js', port: 4173 },
  });
});

it('renders every phase and source and preserves the JSON result shape', () => {
  const result: Result = {
    template: 'fixture',
    node: 'v24.15.0',
    npm: '12.2.2',
    mode: 'registry' as const,
    releaseAgeDays: 7,
    exclude: null,
    browser: null,
    durationMs: 1234,
    failures: [
      {
        phase: 'build' as const,
        gating: true,
        source: 'package:react',
        suggested: true,
        summary: 'Build failed.',
        excerpt: 'missing export',
      },
      {
        phase: 'serve' as const,
        gating: true,
        source: 'environment',
        suggested: true,
        summary: 'Serve failed.',
        excerpt: 'EADDRINUSE',
      },
    ],
  };
  expect(renderResults([result])).toContain('build [package:react]');
  expect(renderResults([result])).toContain('serve [environment]');
  expect(renderResults([result])).toContain('1234 ms');
  expect(JSON.parse(JSON.stringify(result))).toEqual(result);
});

it('runs a real offline npm file install, build and loopback server, then removes its project', async () => {
  const root = await temporary();
  const repo = join(root, 'repo');
  const project = join(repo, 'templates/fixture');
  await mkdir(join(project, 'dependency'), { recursive: true });
  await writeFile(join(repo, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080');
  await writeFile(
    join(project, 'dependency/package.json'),
    JSON.stringify({ name: 'fixture-dependency', version: '1.0.0' }),
  );
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      private: true,
      dependencies: { 'fixture-dependency': 'file:./dependency' },
    }),
  );
  await writeFile(
    join(project, 'build.cjs'),
    "require('node:fs').writeFileSync('built.txt', 'built')",
  );
  await writeFile(
    join(project, 'serve.cjs'),
    "require('node:fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(2))); require('node:http').createServer((q,s)=>s.end('ready')).listen(Number(process.argv[process.argv.indexOf('--port')+1]), '127.0.0.1')",
  );
  await writeBaseline(project);
  let copy = '';
  const results = await runStandalone(
    {
      repo,
      tempBase: root,
      nodes: [{ major: Number(process.versions.node.split('.')[0]) }],
      modes: ['registry'],
      specs: [{ ...fixtureSpec, build: ['build.cjs'], preview: ['serve.cjs'] }],
      offline: true,
      verifyReleaseAge: false,
      cleanPath: true,
    },
    {
      scaffold: scaffoldFixture(project),
      driver: {
        drive: async (url) => {
          expect(new URL(url).hostname).toBe('127.0.0.1');
          const entries = await import('node:fs/promises').then(({ readdir }) => readdir(root));
          const run = entries.find((entry) => entry.startsWith('galaxie-standalone-'));
          expect(run).toBeDefined();
          copy = join(root, run ?? '', `fixture-${process.versions.node.split('.')[0]}-registry`);
          expect(await readFile(join(copy, 'built.txt'), 'utf8')).toBe('built');
          expect(existsSync(join(copy, 'node_modules/fixture-dependency/package.json'))).toBe(true);
          expect(JSON.parse(await readFile(join(copy, 'args.json'), 'utf8'))).toEqual([
            '--host',
            '127.0.0.1',
            '--port',
            new URL(url).port,
            '--strictPort',
          ]);
          return 'stub';
        },
      },
    },
  );
  expect(results[0]?.failures).toEqual([]);
  expect(copy).not.toBe('');
  expect(existsSync(copy)).toBe(false);
}, 30000);

it.each(['within', 'over', 'failed'] as const)(
  'measures each project independently and gates its budget (%s)',
  async (kind) => {
    const root = await realpath(await temporary());
    const repo = join(root, 'repo');
    await mkdir(repo);
    await writeFile(join(repo, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080');
    const commands: Command[] = [];
    let offset = 0;
    const elapsed = kind === 'within' ? 30_000 : 60_001;
    const server = createServer((_request, response) => response.end('ready'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No fixture port.');
    try {
      const results = await runStandalone(
        {
          repo,
          tempBase: root,
          nodes: [{ major: Number(process.versions.node.split('.')[0]) }],
          modes: ['tarball'],
          specs: [fixtureSpec, { ...fixtureSpec, name: 'second-fixture' }].map((spec) => ({
            ...spec,
            build: ['build.cjs'],
          })),
          cleanPath: true,
          budgetMinutes: 1,
        },
        {
          clock: {
            now: () => 1_000_000 + offset,
            sleep: async (ms) => {
              offset += ms;
            },
          },
          scaffold: async ({ directory, env }) => {
            offset += elapsed;
            expect(await readdir(env['PATH'] ?? '')).toEqual(['node', 'sh']);
            expect(env['PATH']).not.toContain(delimiter);
            expect(env['PATH']).not.toBe(dirname(process.execPath));
            await mkdir(directory);
            await writeFile(join(directory, 'package.json'), '{}');
            await writeBaseline(directory);
          },
          runner: {
            run: async (command) => {
              commands.push(command);
              if (command.args[0] === '-e') return processRunner([process.execPath]).run(command);
              if (command.args[0] === '--version') return process.version;
              if (command.args.includes('--version')) return '12.2.2';
              if (command.args.includes('config')) return '7';
              if (command.args[0] === 'pack') {
                const destination = command.args[2];
                if (destination === undefined) throw new Error('No pack destination.');
                await writeFile(
                  join(destination, `galaxie-ai-${basename(command.cwd)}-0.1.0.tgz`),
                  'fixture',
                );
              }
              if (command.args.includes('install'))
                await writeFile(
                  join(command.cwd, 'package-lock.json'),
                  JSON.stringify({
                    packages: Object.fromEntries(
                      expectedLaunch.map((name) => [
                        `node_modules/${name}`,
                        { resolved: 'file:/fixture/package.tgz' },
                      ]),
                    ),
                  }),
                );
              if (command.args[0] === 'build.cjs' && kind === 'failed')
                throw new Error('build-canary');
              if (command.args.includes('check')) {
                const source = await readFile(join(command.cwd, 'src/csp.ts'), 'utf8');
                if (source.includes('unsafe-inline')) throw new Error('script-src changed');
                if (source !== fixtureCsp) throw new Error('require-trusted-types-for changed');
              }
              return '';
            },
            start: async (command) => {
              commands.push(command);
              return {
                stop: async () => {
                  offset += 5000;
                },
                output: () => '',
              };
            },
          },
          ports: { find: async () => address.port },
          driver: { drive: async () => 'fixture-browser' },
        },
      );
      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.durationMs).toBe(elapsed);
        expect(JSON.parse(JSON.stringify(result)).durationMs).toBe(elapsed);
        if (kind === 'within') expect(result.failures).toEqual([]);
        else
          expect(result.failures.filter(({ phase }) => phase === 'budget')).toEqual([
            {
              phase: 'budget',
              gating: true,
              source: 'harness',
              suggested: true,
              summary: 'budget exceeded: 60001 ms of 60000 ms',
              excerpt: '',
            },
          ]);
        if (kind === 'failed')
          expect(result.failures[0]).toMatchObject({ phase: 'build', excerpt: 'build-canary' });
      }
      const pack = commands.filter(
        ({ cwd }) => cwd === repo || cwd.startsWith(join(repo, 'packages')),
      );
      expect(pack).toHaveLength(8);
      expect(pack.every(({ env }) => env['PATH'] === process.env['PATH'])).toBe(true);
      const project = commands.filter((command) => !pack.includes(command));
      expect(project.length).toBeGreaterThan(0);
      expect(
        project.every(({ env }) => env['PATH']?.startsWith(join(root, 'galaxie-standalone-'))),
      ).toBe(true);
      expect(project.filter(({ args }) => args[0] === '-e')).toHaveLength(2);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.each(['go', 'python', 'python3', 'uv'])(
  'requires runtime ENOENT before scaffolding (%s)',
  async (name) => {
    const root = await temporary();
    const repo = join(root, 'repo');
    await mkdir(repo);
    await writeFile(join(repo, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080');
    const scaffold = vi.fn(unexpectedScaffold);
    const results = await runStandalone(
      {
        repo,
        tempBase: root,
        nodes: [{ major: Number(process.versions.node.split('.')[0]) }],
        modes: ['registry'],
        specs: [fixtureSpec],
        cleanPath: true,
      },
      {
        scaffold,
        driver: { drive: async () => 'stub' },
        runner: {
          run: async (command) => {
            if (command.args[0] === '-e') {
              await symlink(process.execPath, join(command.env['PATH'] ?? '', name));
              return processRunner([process.execPath]).run(command);
            }
            if (command.args[0] === '--version') return process.version;
            return '12.2.2';
          },
          start: async () => {
            throw new Error('Unexpected server.');
          },
        },
      },
    );
    expect(scaffold).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      durationMs: 0,
      failures: [
        {
          phase: 'probe',
          gating: true,
          excerpt: expect.stringContaining(`Clean PATH violated: ${name}`),
        },
      ],
    });
  },
);

it.each([
  'pass',
  'unexpected-pass',
  'wrong-message',
  'abort',
  'restored-build-failure',
  'without-clean-path',
  'other-framework',
] as const)(
  'checks edited Go source without Go and restores its original bytes (%s)',
  async (kind) => {
    const root = await temporary();
    const repo = join(root, 'repo');
    await mkdir(repo);
    await writeFile(join(repo, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080');
    const original = Buffer.from('package main\r\n\r\nfunc main() {}\r\n');
    const missingGo = 'The agent source in go/ was edited and Go 1.27.3 was not found on PATH';
    const builds: Buffer[] = [];
    let sourcePath = '';
    let offset = 0;
    const controller = new AbortController();
    const server = createServer((_request, response) => response.end('ready'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No fixture port.');
    try {
      const results = await runStandalone(
        {
          repo,
          tempBase: root,
          keep: true,
          nodes: [{ major: Number(process.versions.node.split('.')[0]) }],
          modes: ['registry'],
          specs: [
            {
              ...fixtureSpec,
              framework: kind === 'other-framework' ? 'langgraph-js' : 'adk-go',
              build: ['fixture-vite.js', 'build'],
            },
          ],
          cleanPath: kind !== 'without-clean-path',
          budgetMinutes: 1,
          signal: controller.signal,
        },
        {
          clock: {
            now: () => 1_000_000 + offset,
            sleep: async (ms) => {
              offset += ms;
            },
          },
          scaffold: async ({ directory }) => {
            offset += 30_000;
            await mkdir(join(directory, 'go'), { recursive: true });
            sourcePath = join(directory, 'go/agent.go');
            await writeFile(sourcePath, original);
            await writeFile(join(directory, 'package.json'), '{}');
            await writeBaseline(directory);
          },
          runner: {
            run: async (command) => {
              if (command.args[0] === '-e') return processRunner([process.execPath]).run(command);
              if (command.args[0] === '--version') return process.version;
              if (command.args.includes('--version')) return '12.2.2';
              if (command.args.includes('config')) return '7';
              if (command.args[0] === 'fixture-vite.js') {
                expect(command.args).toEqual(['fixture-vite.js', 'build']);
                const source = await readFile(sourcePath);
                builds.push(source);
                if (builds.length > 1) offset += 90_000;
                if (!source.equals(original)) {
                  if (kind === 'unexpected-pass') return '';
                  if (kind === 'wrong-message') throw new Error('Unrelated Go build failure.');
                  if (kind === 'abort') controller.abort();
                  throw new Error(
                    `${missingGo}. Install Go 1.27.3, or restore the original go/ source to use the prebuilt agent.`,
                  );
                }
                if (builds.length === 3 && kind === 'restored-build-failure')
                  throw new Error('Restored Go build failed.');
              }
              if (command.args.includes('check')) {
                const source = await readFile(join(command.cwd, 'src/csp.ts'), 'utf8');
                if (source.includes('unsafe-inline')) throw new Error('script-src changed');
                if (source !== fixtureCsp) throw new Error('require-trusted-types-for changed');
              }
              return '';
            },
            start: async () => ({ stop: async () => {}, output: () => '' }),
          },
          ports: { find: async () => address.port },
          driver: {
            drive: async () => {
              offset += 2000;
              return 'fixture-browser';
            },
          },
        },
      );
      expect(await readFile(sourcePath)).toEqual(original);
      expect(builds[0]).toEqual(original);
      const skipped = kind === 'without-clean-path' || kind === 'other-framework';
      const passed = kind === 'pass' || skipped;
      expect(builds).toHaveLength(
        skipped ? 1 : kind === 'pass' || kind === 'restored-build-failure' ? 3 : 2,
      );
      if (!skipped) {
        expect(builds[1]?.subarray(0, original.length)).toEqual(original);
        expect(builds[1]?.length).toBeGreaterThan(original.length);
      }
      if (builds.length === 3) expect(builds[2]).toEqual(original);
      expect(results[0]?.durationMs).toBe(passed ? 32_000 : 30_000);
      if (passed) expect(results[0]?.failures).toEqual([]);
      else {
        expect(results[0]?.failures).toMatchObject([{ phase: 'negative-control', gating: true }]);
        if (kind === 'unexpected-pass')
          expect(results[0]?.failures[0]?.excerpt).toContain(
            'Negative control unexpectedly passed for edited Go source.',
          );
        if (kind === 'wrong-message') {
          expect(results[0]?.failures[0]?.excerpt).toContain(missingGo);
          expect(results[0]?.failures[0]?.excerpt).toContain('Unrelated Go build failure.');
        }
        if (kind === 'restored-build-failure')
          expect(results[0]?.failures[0]?.excerpt).toContain('Restored Go build failed.');
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.each(['throw', 'abort'] as const)(
  'cleans up a failed or aborted pipeline (%s)',
  async (kind) => {
    const root = await temporary();
    const repo = join(root, 'repo');
    await mkdir(join(repo, 'templates/fixture'), { recursive: true });
    await writeFile(join(repo, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080');
    await writeFile(join(repo, 'templates/fixture/package.json'), '{}');
    const controller = new AbortController();
    const result = await runStandalone(
      {
        repo,
        tempBase: root,
        nodes: [{ major: 24 }],
        modes: ['registry'],
        specs: [fixtureSpec],
        signal: controller.signal,
      },
      {
        scaffold: unexpectedScaffold,
        runner: {
          run: async () => {
            if (kind === 'abort') controller.abort();
            throw new Error('fixture failure');
          },
          start: async () => {
            throw new Error('unexpected server');
          },
        },
        driver: { drive: async () => 'stub' },
      },
    );
    expect(result[0]?.failures).not.toEqual([]);
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(root)).filter((name) => name.startsWith('galaxie-standalone-'))).toEqual(
      [],
    );
  },
);

it('rejects an in-repository temp root before creating a project', async () => {
  const repo = await temporary();
  await expect(
    runStandalone(
      { repo, tempBase: repo, nodes: [], specs: [], modes: [] },
      { scaffold: unexpectedScaffold, driver: { drive: async () => 'stub' } },
    ),
  ).rejects.toThrow('outside');
});

it.each(['old-npm', 'ignored-policy', 'effective-policy'] as const)(
  'requires a release-age-capable npm and verifies the effective policy (%s)',
  async (kind) => {
    const root = await temporary();
    const repo = join(root, 'repo');
    await mkdir(join(repo, 'templates/fixture'), { recursive: true });
    await writeFile(join(repo, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080');
    await writeFile(join(repo, 'templates/fixture/package.json'), '{}');
    let installed = false;
    const results = await runStandalone(
      {
        repo,
        tempBase: root,
        nodes: [{ major: 24 }],
        modes: ['registry'],
        specs: [{ ...fixtureSpec, build: ['build.js'] }],
      },
      {
        scaffold: scaffoldFixture(join(repo, 'templates/fixture')),
        driver: { drive: async () => 'stub' },
        runner: {
          run: async (command) => {
            if (command.args[0] === '--version') return 'v24.15.0';
            if (command.args.includes('--version')) return kind === 'old-npm' ? '11.0.0' : '12.2.2';
            if (command.args.includes('config'))
              return kind === 'ignored-policy' ? 'undefined' : '7';
            if (command.args.includes('install')) {
              installed = true;
              return '';
            }
            throw new Error('build-canary');
          },
          start: async () => {
            throw new Error('unexpected server');
          },
        },
      },
    );
    expect(installed).toBe(kind === 'effective-policy');
    expect(results[0]?.failures).toMatchObject([
      {
        phase: kind === 'old-npm' ? 'node' : kind === 'ignored-policy' ? 'install' : 'build',
        excerpt:
          kind === 'old-npm'
            ? 'npm version 12 or later is required for release-age enforcement.'
            : kind === 'ignored-policy'
              ? 'npm release-age policy did not take effect.'
              : 'build-canary',
      },
    ]);
  },
);

it.each([
  'pass',
  'probe',
  'probe-short',
  'external',
  'pageerror',
  'console',
  'probe-twice',
] as const)(
  'drives real Chromium offline and detects forbidden behavior (%s)',
  async (kind) => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      const bad = {
        pass: '',
        probe:
          'console.error("This document requires \'TrustedScript\' assignment. The action has been blocked.")',
        'probe-short': 'console.error("This document requires \'TrustedScript\' assignment.")',
        external: "fetch('https://example.invalid/x').catch(()=>{})",
        pageerror: "setTimeout(()=>{throw Error('page-canary')},0)",
        console: "console.error('console-canary')",
        'probe-twice':
          'console.error("This document requires \'TrustedScript\' assignment.");console.error("This document requires \'TrustedScript\' assignment.")',
      }[kind];
      response.end(
        `<input type="radio" aria-label="4"><button onclick="document.querySelector('p').textContent='Finished'">Submit answers</button><p>Waiting</p><script>${bad}</script>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No port');
    try {
      const drive = driveChromium(`http://127.0.0.1:${address.port}`, {
        ...fixtureSpec,
        build: [],
        preview: [],
        steps: [
          { action: 'check', role: 'radio', name: '4' },
          { action: 'click', role: 'button', name: 'Submit answers' },
          { action: 'text', name: 'Finished' },
        ],
      });
      if (kind === 'pass' || kind === 'probe' || kind === 'probe-short')
        expect(await drive).toMatch(/\d+\./);
      else await expect(drive).rejects.toThrow(/Cross-origin|Page error|Console error/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30000,
);

it.each([
  'expected',
  'uncorrelated',
  'other-path',
  '500',
  'outside-step',
  'failed-request',
] as const)(
  'correlates the unavailable diagnostic with the response and deliberate step (%s)',
  async (kind) => {
    const path = '/api/v1/chat/completions';
    const server = createServer((request, response) => {
      if (request.url !== '/') {
        if (kind === 'failed-request') {
          request.socket.destroy();
          return;
        }
        response.writeHead(kind === '500' ? 500 : 503);
        response.end('unavailable');
        return;
      }
      response.setHeader('content-type', 'text/html');
      const diagnostic =
        kind === 'uncorrelated'
          ? "console.error('Failed to load resource: the server responded with a status of 503 (Service Unavailable)');"
          : '';
      const action = `document.querySelector('p').textContent='Waiting'; fetch('${kind === 'other-path' ? '/other' : path}').catch(()=>{}).finally(()=>{${diagnostic}document.querySelector('p').textContent='Unavailable'})`;
      response.end(
        `<button onclick="${action}">Submit answers</button><p>Waiting</p>${kind === 'outside-step' ? `<script>${action}</script>` : ''}`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No port');
    try {
      const drive = driveChromium(`http://127.0.0.1:${address.port}`, {
        ...fixtureSpec,
        build: [],
        preview: [],
        steps: [
          ...(kind === 'outside-step' ? [{ action: 'text' as const, name: 'Unavailable' }] : []),
          {
            action: 'click',
            role: 'button',
            name: 'Submit answers',
            unavailable: { path, text: 'Unavailable' },
          },
        ],
      });
      if (kind === 'expected') expect(await drive).toMatch(/\d+\./);
      else if (kind === 'uncorrelated')
        await expect(drive).rejects.toThrow('Console error: uncorrelated HTTP status 503.');
      else if (kind === '500') await expect(drive).rejects.toThrow('HTTP status 500.');
      else if (kind === 'outside-step' || kind === 'other-path')
        await expect(drive).rejects.toThrow('HTTP status 503.');
      else if (kind === 'failed-request') await expect(drive).rejects.toThrow('Request failed.');
      else await expect(drive).rejects.toThrow(/Console error|HTTP status|Request failed/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30000,
);

it('keeps a refused binary associated with the requested Node major', async () => {
  const repo = await temporary();
  const base = await temporary();
  await writeFile(join(repo, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080');
  const results = await runStandalone(
    {
      repo,
      tempBase: base,
      nodes: [{ major: 22, path: process.execPath }],
      modes: ['registry', 'tarball'],
      tarballs: join(base, 'absent'),
      specs: [fixtureSpec],
    },
    {
      scaffold: unexpectedScaffold,
      runner: {
        run: async () => 'v24.15.0',
        start: async () => {
          throw new Error('unexpected server');
        },
      },
      driver: { drive: async () => 'stub' },
    },
  );
  expect(results.map(({ node }) => node)).toEqual(['22', '22']);
  expect(results.map(({ failures }) => failures[0])).toMatchObject([
    { phase: 'node', source: 'environment', gating: true },
    { phase: 'node', source: 'environment', gating: true },
  ]);
  expect(renderResults(results)).toContain('fixture | 22 | npm unknown | registry | FAIL');
});

it
  .skipIf(process.platform === 'win32')
  .each(['traps-sigterm', 'leader-exited', 'closed-stdio'] as const)(
  'aborts the owned process group even when its launcher %s',
  async (kind) => {
    const directory = await temporary();
    const controller = new AbortController();
    const script =
      kind === 'traps-sigterm'
        ? "process.on('SIGTERM',()=>{});require('node:fs').writeFileSync('ready.json',JSON.stringify({leader:process.pid}));setInterval(()=>{},1000)"
        : `const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:${kind === 'closed-stdio' ? "'ignore'" : "['ignore',1,2]"}});require('node:fs').writeFileSync('ready.json',JSON.stringify({leader:process.pid,descendant:child.pid}));process.exit(0)`;
    let leader: number | undefined;
    let descendant: number | undefined;
    let finished = false;
    const completion = processRunner([process.execPath])
      .run({
        executable: process.execPath,
        args: ['-e', script],
        cwd: directory,
        env: {},
        signal: controller.signal,
      })
      .finally(() => {
        finished = true;
      });
    void completion.catch(() => {});
    try {
      await vi.waitFor(() => expect(existsSync(join(directory, 'ready.json'))).toBe(true), {
        timeout: 5000,
      });
      const ids = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8')) as {
        leader: number;
        descendant?: number;
      };
      leader = ids.leader;
      descendant = ids.descendant;
      if (kind === 'leader-exited')
        await vi.waitFor(() => expect(() => process.kill(leader ?? 0, 0)).toThrow(), {
          timeout: 5000,
        });
      controller.abort();
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 5000 });
      if (descendant !== undefined)
        await vi.waitFor(() => expect(() => process.kill(descendant ?? 0, 0)).toThrow(), {
          timeout: 5000,
        });
    } finally {
      if (leader !== undefined) {
        try {
          process.kill(-leader, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
      await completion.catch(() => {});
    }
  },
  15000,
);

it.skipIf(process.platform === 'win32')(
  'cleans the temporary project on SIGINT during a real Chromium drive',
  async () => {
    const root = await temporary();
    const repo = join(root, 'repo');
    const runs = join(root, 'runs');
    const fixture = join(repo, 'templates/fixture');
    await mkdir(fixture, { recursive: true });
    await mkdir(runs);
    await writeFile(join(repo, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080');
    await writeFile(join(fixture, 'package.json'), '{"name":"fixture","private":true}');
    await writeFile(join(fixture, 'build.cjs'), '');
    await writeBaseline(fixture);
    await writeFile(
      join(fixture, 'serve.cjs'),
      "const fs=require('node:fs');let gets=0;fs.writeFileSync('server.pid',String(process.pid));require('node:http').createServer((q,s)=>{if(++gets===2)fs.writeFileSync('browser-ready','ready');s.end('<p>Ready</p>')}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1')",
    );
    const script = `const {runStandalone}=await import(${JSON.stringify(new URL('../../scripts/standalone-core.ts', import.meta.url).href)});const {driveChromium}=await import(${JSON.stringify(new URL('../../scripts/verify-standalone.ts', import.meta.url).href)});await runStandalone(${JSON.stringify({ repo, tempBase: runs, nodes: [{ major: 24 }], modes: ['registry'], offline: true, verifyReleaseAge: false, specs: [{ ...fixtureSpec, build: ['build.cjs'], preview: ['serve.cjs'], steps: [{ action: 'text', name: 'Never rendered' }] }] })},{scaffold:async({directory})=>{await(await import('node:fs/promises')).cp(${JSON.stringify(fixture)},directory,{recursive:true})},driver:{drive:driveChromium}});console.log('cleanup-complete');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: repo,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (bytes: Buffer) => {
      output += bytes.toString();
    });
    child.stderr.on('data', (bytes: Buffer) => {
      output += bytes.toString();
    });
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    let server: number | undefined;
    try {
      let project = '';
      await vi.waitFor(
        async () => {
          const entry = (await readdir(runs)).find((name) =>
            name.startsWith('galaxie-standalone-'),
          );
          project = join(runs, entry ?? '', 'fixture-24-registry');
          expect(existsSync(join(project, 'browser-ready'))).toBe(true);
        },
        { timeout: 15000 },
      );
      server = Number(await readFile(join(project, 'server.pid'), 'utf8'));
      child.kill('SIGINT');
      expect(await completed).toBe(0);
      expect(output).toContain('cleanup-complete');
      expect(await readdir(runs)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      if (server !== undefined) {
        try {
          process.kill(-server, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
      await completed;
    }
  },
  25000,
);

it.each(['root', 'file', 'directory'] as const)(
  'refuses scaffold symlinks (%s), with a real-directory control',
  async (kind) => {
    const root = await temporary();
    const project = join(root, 'project');
    await mkdir(project);
    await writeFile(join(project, 'package.json'), '{}');
    await assertCopy(project);
    if (kind === 'root') {
      const link = join(root, 'linked');
      await symlink(project, link);
      await expect(assertCopy(link)).rejects.toThrow('symlink');
    } else {
      await mkdir(join(project, 'nested'));
      await symlink(
        kind === 'file' ? join(project, 'package.json') : project,
        join(project, 'nested/linked'),
      );
      await expect(assertCopy(project)).rejects.toThrow('symlink');
    }
  },
);

it('gives build and preview children only the allowlisted environment', async () => {
  const root = await temporary();
  const repo = join(root, 'repo');
  const project = join(repo, 'templates/fixture');
  await mkdir(project, { recursive: true });
  await writeFile(join(repo, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080');
  await writeFile(
    join(project, 'package.json'),
    JSON.stringify({ name: 'fixture', private: true }),
  );
  const dump =
    "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(Object.keys(process.env)));";
  await writeFile(join(project, 'build.cjs'), dump.replace('process.argv[1]', "'env-build.json'"));
  await writeFile(
    join(project, 'serve.cjs'),
    `${dump.replace('process.argv[1]', "'env-serve.json'")} require('node:http').createServer((q,s)=>s.end('ready')).listen(Number(process.argv[process.argv.indexOf('--port')+1]), '127.0.0.1')`,
  );
  await writeBaseline(project);
  const keys: string[][] = [];
  const results = await runStandalone(
    {
      repo,
      tempBase: root,
      nodes: [{ major: Number(process.versions.node.split('.')[0]) }],
      modes: ['registry'],
      specs: [{ ...fixtureSpec, build: ['build.cjs'], preview: ['serve.cjs'] }],
      offline: true,
      verifyReleaseAge: false,
    },
    {
      scaffold: scaffoldFixture(project),
      environment: {
        PATH: process.env['PATH'],
        HOME: process.env['HOME'],
        NPM_TOKEN: 'canary',
        NODE_AUTH_TOKEN: 'canary',
        UPSTREAM_API_KEY: 'canary',
        NODE_OPTIONS: '--no-warnings',
        npm_config_registry: 'https://example.invalid/',
      },
      driver: {
        drive: async () => {
          const entries = await readdir(root);
          const run = entries.find((entry) => entry.startsWith('galaxie-standalone-')) ?? '';
          const copy = join(root, run, `fixture-${process.versions.node.split('.')[0]}-registry`);
          for (const file of ['env-build.json', 'env-serve.json'])
            keys.push(JSON.parse(await readFile(join(copy, file), 'utf8')) as string[]);
          return 'stub';
        },
      },
    },
  );
  expect(results[0]?.failures).toEqual([]);
  expect(keys).toHaveLength(2);
  for (const names of keys) {
    expect(names).toContain('PATH');
    for (const forbidden of ['NPM_TOKEN', 'NODE_AUTH_TOKEN', 'UPSTREAM_API_KEY', 'NODE_OPTIONS'])
      expect(names).not.toContain(forbidden);
  }
}, 30000);

it.each([
  'pass',
  'conditional-true',
  'conditional-false',
  'both',
  'test-artifact',
  'workspace-artifact',
  'check-failure',
  'negative-pass',
  'negative-wrong',
  'negative-abort',
  'mutation-missing',
] as const)('gates scaffold/check/mutation phases and restores the source (%s)', async (kind) => {
  const baseline = kind.startsWith('conditional-')
    ? fixtureCsp.replace(
        "'script-src': [\"'self'\"]",
        "'script-src': frameworkProfile.workers ? [\"'self'\", \"'wasm-unsafe-eval'\"] : [\"'self'\"]",
      )
    : fixtureCsp;
  const root = await temporary();
  const repo = join(root, 'repo');
  await mkdir(repo);
  await writeFile(join(repo, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080');
  const packed = join(root, 'packed');
  await mkdir(packed);
  for (const name of expectedLaunch)
    await writeFile(join(packed, `galaxie-ai-${name.split('/')[1]}-0.1.0.tgz`), 'fixture');
  const requests: ScaffoldRequest[] = [];
  const controller = new AbortController();
  let checks = 0;
  let installs = 0;
  const server = createServer((_request, response) => response.end('ready'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No fixture port.');
  try {
    const results = await runStandalone(
      {
        repo,
        tempBase: root,
        nodes: [{ major: Number(process.versions.node.split('.')[0]) }],
        modes: kind === 'both' ? ['registry', 'tarball'] : ['registry'],
        tarballs: packed,
        specs: [{ ...fixtureSpec, name: 'browser-only-langgraph-js' }],
        keep: true,
        signal: controller.signal,
      },
      {
        scaffold: async (request) => {
          requests.push(request);
          await mkdir(join(request.directory, 'src'), { recursive: true });
          await writeFile(
            join(request.directory, 'package.json'),
            JSON.stringify({ dependencies: { '@galaxie-ai/core': '^0.1.0' } }),
          );
          await writeFile(
            join(request.directory, 'src/csp.ts'),
            kind === 'mutation-missing' ? 'not a CSP fixture' : baseline,
          );
          if (kind === 'test-artifact') await mkdir(join(request.directory, 'test'));
          if (kind === 'workspace-artifact')
            await writeFile(join(request.directory, 'tsconfig.workspace.json'), '{}');
        },
        runner: {
          run: async (command) => {
            if (command.args[0] === '--version') return process.version;
            if (command.args.includes('--version')) return '12.2.2';
            if (command.args.includes('config')) return '7';
            if (command.args.includes('install')) {
              installs++;
              expect(command.args.slice(1)).toEqual([
                'install',
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
              ]);
              await writeFile(
                join(command.cwd, 'package-lock.json'),
                JSON.stringify({
                  packages: Object.fromEntries(
                    expectedLaunch.map((name) => [
                      `node_modules/${name}`,
                      { resolved: `file:/fixture/${name.split('/')[1]}.tgz` },
                    ]),
                  ),
                }),
              );
              return '';
            }
            if (command.args.includes('check')) {
              checks++;
              const source = await readFile(join(command.cwd, 'src/csp.ts'), 'utf8');
              if (kind === 'check-failure') throw new Error('src/csp.ts fixture check failed.');
              if (source === baseline || kind === 'mutation-missing') return '';
              if (kind.startsWith('conditional-') && source.includes('unsafe-inline')) {
                const expression = /'script-src': (.*),/.exec(source)?.[1];
                const active = new Function('frameworkProfile', `return (${expression});`)({
                  workers: kind === 'conditional-true',
                });
                expect(active).toContain("'unsafe-inline'");
              }
              if (kind === 'negative-pass') return '';
              if (kind === 'negative-wrong') throw new Error('Unrelated compiler failure.');
              if (kind === 'negative-abort') {
                controller.abort();
                throw new Error('Interrupted check.');
              }
              throw new Error(
                source.includes('unsafe-inline')
                  ? 'script-src changed'
                  : 'require-trusted-types-for changed',
              );
            }
            return '';
          },
          start: async () => ({ stop: async () => {}, output: () => '' }),
        },
        ports: { find: async () => address.port },
        driver: { drive: async () => 'fixture-browser' },
      },
    );
    expect(requests).toHaveLength(kind === 'both' ? 2 : 1);
    expect(
      requests.map(({ spec, mode, directory, tarballs }) => ({
        name: spec.name,
        kind: spec.kind,
        framework: spec.framework,
        mode,
        directory: basename(directory),
        tarballs: tarballs === undefined ? undefined : basename(tarballs),
      })),
    ).toEqual([
      {
        name: 'browser-only-langgraph-js',
        kind: 'browser-only',
        framework: 'langgraph-js',
        mode: 'registry',
        directory: `browser-only-langgraph-js-${process.versions.node.split('.')[0]}-registry`,
        tarballs: undefined,
      },
      ...(kind === 'both'
        ? [
            {
              name: 'browser-only-langgraph-js',
              kind: 'browser-only',
              framework: 'langgraph-js',
              mode: 'tarball',
              directory: `browser-only-langgraph-js-${process.versions.node.split('.')[0]}-tarball`,
              tarballs: 'tarballs',
            },
          ]
        : []),
    ]);
    for (const request of requests) {
      expect(request.node).toBe(process.execPath);
      expect(await readFile(join(request.directory, 'src/csp.ts'), 'utf8')).toBe(
        kind === 'mutation-missing' ? 'not a CSP fixture' : baseline,
      );
    }
    if (kind === 'pass' || kind === 'both' || kind.startsWith('conditional-')) {
      expect(results.every(({ failures }) => failures.length === 0)).toBe(true);
      expect(checks).toBe(kind === 'both' ? 6 : 3);
      expect(installs).toBe(kind === 'both' ? 2 : 1);
    } else {
      const phase = kind.endsWith('artifact')
        ? 'scaffold'
        : kind === 'check-failure'
          ? 'check'
          : 'negative-control';
      expect(results[0]?.failures).toMatchObject([{ phase, gating: true }]);
      if (kind.endsWith('artifact')) expect(results[0]?.failures[0]?.source).toBe('harness');
      if (kind === 'check-failure') expect(results[0]?.failures[0]?.source).toBe('template');
      if (kind === 'negative-pass' || kind === 'negative-wrong' || kind === 'mutation-missing')
        expect(results[0]?.failures[0]?.source).toBe('harness');
      if (kind === 'negative-pass')
        expect(results[0]?.failures[0]?.excerpt).toContain(
          'Negative control unexpectedly passed for script-src.',
        );
      if (kind === 'negative-wrong')
        expect(results[0]?.failures[0]?.excerpt).toContain(
          'Negative control did not report script-src changed.',
        );
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([true, false])(
  'selects per-server drive steps with a preview fallback (%s)',
  async (override) => {
    const root = await temporary();
    const repo = join(root, 'repo');
    await mkdir(repo);
    await writeFile(join(repo, 'pnpm-workspace.yaml'), 'minimumReleaseAge: 10080');
    const server = createServer((_request, response) => response.end('ready'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No fixture port.');
    const previewSteps = [{ action: 'text', name: 'Preview mock reply' }] as const;
    const productionSteps = [{ action: 'text', name: 'Production unavailable' }] as const;
    const driven: (readonly Step[])[] = [];
    const specs: TemplateSpec[] = [
      { ...fixtureSpec, name: 'browser-fixture', steps: previewSteps },
      {
        ...fixtureSpec,
        name: 'gateway-fixture',
        kind: 'gateway',
        steps: previewSteps,
        server: {
          compile: [],
          entry: 'production.js',
          port: address.port,
          ...(override ? { steps: productionSteps } : {}),
        },
      },
    ];
    try {
      const results = await runStandalone(
        {
          repo,
          tempBase: root,
          nodes: [{ major: Number(process.versions.node.split('.')[0]) }],
          modes: ['registry'],
          specs,
          offline: true,
          verifyReleaseAge: false,
        },
        {
          scaffold: async ({ directory }) => {
            await mkdir(directory, { recursive: true });
            await writeFile(join(directory, 'package.json'), '{}');
            await writeBaseline(directory);
          },
          runner: {
            run: async (command) => {
              if (command.args[0] === '--version') return process.version;
              if (command.args.includes('--version')) return '12.2.2';
              if (command.args.includes('check')) {
                const source = await readFile(join(command.cwd, 'src/csp.ts'), 'utf8');
                if (source.includes('unsafe-inline')) throw new Error('script-src changed');
                if (source !== fixtureCsp) throw new Error('require-trusted-types-for changed');
              }
              return '';
            },
            start: async () => ({ stop: async () => {}, output: () => '' }),
          },
          ports: { find: async () => address.port },
          driver: {
            drive: async (_url, spec) => {
              driven.push(spec.steps);
              return 'fixture-browser';
            },
          },
        },
      );
      expect(results.map(({ failures }) => failures)).toEqual([[], []]);
      expect(driven).toEqual([
        previewSteps,
        previewSteps,
        override ? productionSteps : previewSteps,
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it('selects the ADK tarball matrix and refuses registry or unknown frameworks', () => {
  expect(parseArguments(['--framework', 'adk-js', '--mode', 'tarball'])).toMatchObject({
    framework: 'adk-js',
    mode: 'tarball',
  });
  expect(parseArguments([]).framework).toBe('langgraph-js');
  for (const mode of ['registry', 'both'])
    expect(() => parseArguments(['--framework', 'adk-js', '--mode', mode])).toThrow('Usage');
  expect(() => parseArguments(['--framework', 'unknown'])).toThrow('Usage');
});

it('pins the ADK drive strings to each composed framework export', async () => {
  for (const { kind, framework } of templateSpecs.filter(
    (spec) => spec.framework !== 'langgraph-js',
  )) {
    const executor = await import(
      new URL(
        `../../packages/create/.cache/composed/${kind}-${framework}/src/executor.ts`,
        import.meta.url,
      ).href
    );
    const spec = templateSpecs.find((spec) => spec.kind === kind && spec.framework === framework);
    const original = templateSpecs.find(
      (spec) => spec.kind === kind && spec.framework === 'langgraph-js',
    );
    const reply = kind === 'browser-only' ? executor.mockReply : executor.gatewayReply;
    expect(spec?.steps).toEqual(
      original?.steps.map((step) =>
        step.action === 'text' && step.name.startsWith('Correct. ')
          ? { ...step, name: executor.expectedResult(reply) }
          : step,
      ),
    );
    expect(spec?.server).toEqual(original?.server);
  }
});

it('allows only the ADK extra package in ADK single-copy checks', () => {
  const packages = { 'node_modules/@galaxie-ai/adapter-adk': { resolved: 'file:/tmp/adk.tgz' } };
  expect(() =>
    assertSingleCopies({ packages }, ['@galaxie-ai/adapter-adk'], 'adk-js'),
  ).not.toThrow();
  expect(() => assertSingleCopies({ packages }, ['@galaxie-ai/adapter-adk'])).toThrow(
    'Single-copy',
  );
  expect(() =>
    assertSingleCopies(
      {
        packages: {
          ...packages,
          'node_modules/@galaxie-ai/adapter-go': { resolved: 'file:/tmp/go.tgz' },
        },
      },
      ['@galaxie-ai/adapter-adk'],
      'adk-js',
    ),
  ).toThrow('Single-copy');
});

it('selects Go only in tarball mode and uses the ADK browser drive', () => {
  expect(parseArguments(['--framework', 'adk-go', '--mode', 'tarball'])).toMatchObject({
    framework: 'adk-go',
    mode: 'tarball',
  });
  for (const mode of ['registry', 'both'])
    expect(() => parseArguments(['--framework', 'adk-go', '--mode', mode])).toThrow('Usage');
  expect(templateSpecs.find((spec) => spec.framework === 'adk-go')?.steps).toEqual(
    templateSpecs.find((spec) => spec.framework === 'adk-js' && spec.kind === 'browser-only')
      ?.steps,
  );
});

it('allows exactly the two Go artifact packages in Go single-copy checks', () => {
  const required = ['@galaxie-ai/adapter-go', '@galaxie-ai/starter-go'];
  const packages = Object.fromEntries(
    required.map((name) => [`node_modules/${name}`, { resolved: 'file:/tmp/package.tgz' }]),
  );
  expect(() => assertSingleCopies({ packages }, required, 'adk-go')).not.toThrow();
  expect(() => assertSingleCopies({ packages }, required, 'adk-js')).toThrow('Single-copy');
  expect(() =>
    assertSingleCopies(
      {
        packages: {
          ...packages,
          'node_modules/@galaxie-ai/adapter-adk': { resolved: 'file:/tmp/adk.tgz' },
        },
      },
      required,
      'adk-go',
    ),
  ).toThrow('Single-copy');
});

it('selects Python only in tarball mode and retains the LangGraph drive', () => {
  expect(parseArguments(['--framework', 'langgraph-python', '--mode', 'tarball'])).toMatchObject({
    framework: 'langgraph-python',
    mode: 'tarball',
  });
  for (const mode of ['registry', 'both'])
    expect(() => parseArguments(['--framework', 'langgraph-python', '--mode', mode])).toThrow(
      'Usage',
    );
  for (const kind of ['browser-only', 'gateway'])
    expect(
      templateSpecs.find((spec) => spec.kind === kind && spec.framework === 'langgraph-python')
        ?.steps,
    ).toEqual(
      templateSpecs.find((spec) => spec.kind === kind && spec.framework === 'langgraph-js')?.steps,
    );
});

it('allows exactly the two Python packages as file-resolved single copies', () => {
  const required = ['@galaxie-ai/adapter-pyodide', '@galaxie-ai/starter-python'];
  const packages = Object.fromEntries(
    required.map((name) => [`node_modules/${name}`, { resolved: 'file:/tmp/python.tgz' }]),
  );
  expect(() => assertSingleCopies({ packages }, required, 'langgraph-python')).not.toThrow();
  for (const framework of ['langgraph-js', 'adk-js', 'adk-go'])
    expect(() => assertSingleCopies({ packages }, required, framework)).toThrow('Single-copy');
  for (const name of required) {
    expect(() =>
      assertSingleCopies(
        {
          packages: {
            ...packages,
            [`node_modules/${name}`]: { resolved: 'https://registry.npmjs.org/python.tgz' },
          },
        },
        required,
        'langgraph-python',
      ),
    ).toThrow('Single-copy');
    expect(() =>
      assertSingleCopies(
        {
          packages: {
            ...packages,
            [`node_modules/nested/node_modules/${name}`]: { resolved: 'file:/tmp/python.tgz' },
          },
        },
        required,
        'langgraph-python',
      ),
    ).toThrow('Single-copy');
  }
  expect(() =>
    assertSingleCopies(
      {
        packages: {
          ...packages,
          'node_modules/@galaxie-ai/adapter-go': { resolved: 'file:/tmp/go.tgz' },
        },
      },
      required,
      'langgraph-python',
    ),
  ).toThrow('Single-copy');
});
