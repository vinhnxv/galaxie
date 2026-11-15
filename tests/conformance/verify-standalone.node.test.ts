// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Result } from '../../scripts/standalone-core.js';
import {
  assertCommand,
  assertCopy,
  assertOutside,
  assertSingleCopies,
  classify,
  compareModes,
  copyProject,
  isolatedEnvironment,
  launchPackages,
  nodeBinary,
  redact,
  releaseAgeDays,
  rewriteManifest,
  runStandalone,
} from '../../scripts/standalone-core.js';
import {
  driveChromium,
  parseArguments,
  renderResults,
  templateSpecs,
} from '../../scripts/verify-standalone.js';

const directories: string[] = [];
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

it('rewrites all launch overrides while preserving third parties and the registry manifest', () => {
  expect(launchPackages).toEqual(expectedLaunch);
  const manifest = { dependencies: { '@galaxie-ai/core': '^0.1.0', react: '19.3.1' } };
  const tarballs = Object.fromEntries(
    expectedLaunch.map((name) => [name, `/tmp/${name.split('/')[1]}.tgz`]),
  );
  expect(rewriteManifest(manifest)).toEqual(manifest);
  expect(rewriteManifest(manifest, tarballs)).toEqual({
    dependencies: { '@galaxie-ai/core': 'file:/tmp/core.tgz', react: '19.3.1' },
    overrides: Object.fromEntries(
      expectedLaunch.map((name) => [name, `file:/tmp/${name.split('/')[1]}.tgz`]),
    ),
  });
  expect(manifest.dependencies['@galaxie-ai/core']).toBe('^0.1.0');
  expect(() => rewriteManifest({ dependencies: { '@galaxie-ai/missing': '1' } }, tarballs)).toThrow(
    'Missing tarball',
  );
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

it('copies outside the repository, strips workspace artifacts and detects surviving ones', async () => {
  const root = await temporary();
  const source = join(root, 'repo/template');
  await mkdir(join(source, 'test'), { recursive: true });
  await writeFile(join(source, 'package.json'), '{}');
  await writeFile(join(source, 'test/test.ts'), '');
  await writeFile(join(source, 'tsconfig.workspace.json'), '{}');
  const destination = join(root, 'copy');
  await copyProject(source, destination);
  expect(await readFile(join(destination, 'package.json'), 'utf8')).toBe('{}');
  expect(existsSync(join(destination, 'test'))).toBe(false);
  expect(existsSync(join(destination, 'tsconfig.workspace.json'))).toBe(false);
  await assertCopy(destination);
  await writeFile(join(destination, 'tsconfig.workspace.json'), '{}');
  await expect(assertCopy(destination)).rejects.toThrow('Workspace artifact');
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
    parseArguments(['--node', '22=/p', '--node', '24', '--mode', 'both', '--keep']),
  ).toMatchObject({ nodes: [{ major: 22, path: '/p' }, { major: 24 }], mode: 'both', keep: true });
  expect(parseArguments(['--help']).help).toBe(true);
  for (const args of [
    ['--wat'],
    ['--node'],
    ['--node', '22='],
    ['--template', 'missing'],
    ['--mode', 'missing'],
  ])
    expect(() => parseArguments(args)).toThrow('Usage');
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
  let copy = '';
  const results = await runStandalone(
    {
      repo,
      tempBase: root,
      nodes: [{ major: Number(process.versions.node.split('.')[0]) }],
      modes: ['registry'],
      specs: [{ name: 'fixture', build: ['build.cjs'], preview: ['serve.cjs'], steps: [] }],
      offline: true,
      verifyReleaseAge: false,
    },
    {
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
        specs: [{ name: 'fixture', build: [], preview: [], steps: [] }],
        signal: controller.signal,
      },
      {
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
      { driver: { drive: async () => 'stub' } },
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
        specs: [{ name: 'fixture', build: ['build.js'], preview: [], steps: [] }],
      },
      {
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

it.each(['pass', 'probe', 'external', 'pageerror', 'console', 'probe-twice'] as const)(
  'drives real Chromium offline and detects forbidden behavior (%s)',
  async (kind) => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      const bad = {
        pass: '',
        probe:
          'console.error("This document requires \'TrustedScript\' assignment. The action has been blocked.")',
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
        name: 'fixture',
        build: [],
        preview: [],
        steps: [
          { action: 'check', role: 'radio', name: '4' },
          { action: 'click', role: 'button', name: 'Submit answers' },
          { action: 'text', name: 'Finished' },
        ],
      });
      if (kind === 'pass' || kind === 'probe') expect(await drive).toMatch(/\d+\./);
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
        response.writeHead(kind === '500' ? 500 : kind === 'uncorrelated' ? 200 : 503);
        response.end('unavailable');
        return;
      }
      response.setHeader('content-type', 'text/html');
      const action =
        kind === 'uncorrelated'
          ? "console.error('Failed to load resource: the server responded with a status of 503 (Service Unavailable)'); document.querySelector('p').textContent='Unavailable'"
          : `fetch('${kind === 'other-path' ? '/other' : path}').catch(()=>{}).finally(()=>{document.querySelector('p').textContent='Unavailable'})`;
      response.end(
        `<button onclick="${kind === 'outside-step' ? '' : action}">Submit answers</button><p>Waiting</p>${kind === 'outside-step' ? `<script>${action}</script>` : ''}`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('No port');
    try {
      const drive = driveChromium(`http://127.0.0.1:${address.port}`, {
        name: 'hybrid-gateway',
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
      else await expect(drive).rejects.toThrow(/Console error|HTTP status|Request failed/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  30000,
);
