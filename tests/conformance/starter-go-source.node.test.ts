// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  buildAgent,
  buildEnvironment,
  buildSettings,
  checkBuildSettings,
} from '../../packages/starter-go/src/build-env.js';
import { hashTree, sourceHash } from '../../packages/starter-go/src/source-hash.js';

const temporary: string[] = [];
async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'galaxie-starter-source-'));
  temporary.push(dir);
  await writeFile(join(dir, 'main.go'), 'package main\n');
  return dir;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function proxyOfflineReason(endpoint: string): Promise<string | undefined> {
  if (endpoint === 'off') return 'module downloads are disabled by GOPROXY=off.';
  const url = new URL(endpoint);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Go module proxy probe returned HTTP ${response.status}.`);
  } catch (error) {
    const failure = error as { name?: string; cause?: { code?: string } };
    const code = failure.cause?.code;
    if (
      failure.name !== 'TimeoutError' &&
      ![
        'ENOTFOUND',
        'EAI_AGAIN',
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'ENETUNREACH',
        'EHOSTUNREACH',
        'UND_ERR_CONNECT_TIMEOUT',
      ].includes(code ?? '')
    )
      throw error;
    return 'the configured Go module proxy is unreachable.';
  }
  return undefined;
}
test('source identity includes bytes, paths, additions, version and module source', async () => {
  const dir = await fixture();
  const hash = () => sourceHash(dir, '0.0.0', 'module-a');
  const original = await hash();
  expect(await hash()).toBe(original);
  expect(await sourceHash(dir, '0.0.1', 'module-a')).not.toBe(original);
  expect(await sourceHash(dir, '0.0.0', 'module-b')).not.toBe(original);
  await writeFile(join(dir, 'main.go'), 'package main\r\n');
  expect(await hash()).not.toBe(original);
  await writeFile(join(dir, 'main.go'), 'package main\n');
  await rename(join(dir, 'main.go'), join(dir, 'agent.go'));
  expect(await hash()).not.toBe(original);
  await rename(join(dir, 'agent.go'), join(dir, 'main.go'));
  await writeFile(join(dir, 'extra'), 'x');
  expect(await hash()).not.toBe(original);
  await rm(join(dir, 'extra'));
  for (const name of ['.git', 'node_modules']) {
    await mkdir(join(dir, name));
    await writeFile(join(dir, name, 'extra'), 'x');
  }
  await writeFile(join(dir, '.DS_Store'), 'x');
  expect(await hash()).toBe(original);
  for (const name of ['.x/lib.go', '_x/lib.go', 'go.sum', 'go.mod']) {
    const path = join(dir, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'first\n');
    const before = await hash();
    expect(before, name).not.toBe(original);
    await writeFile(path, 'second\n');
    expect(await hash(), name).not.toBe(before);
    await rm(name.includes('/') ? join(path, '..') : path, { recursive: true, force: true });
    expect(await hash(), name).toBe(original);
  }
  await symlink(join(dir, 'main.go'), join(dir, 'link.go'));
  await expect(hash()).rejects.toThrow('symlink');
});
test('tree framing is deterministic and unambiguous', async () => {
  const dir = await fixture();
  const hash = await hashTree(dir);
  const other = await fixture();
  expect(await hashTree(other)).toBe(hash);
  await writeFile(join(other, 'main.go'), 'package main!\n');
  expect(await hashTree(other)).not.toBe(hash);
});
test('the starter module shares the locked dependencies and checksums', async () => {
  const original = await readFile('go/go.mod', 'utf8');
  const starter = await readFile('templates/frameworks/adk-go/files/go/go.mod', 'utf8');
  expect(starter.match(/require \([\s\S]*?\n\)/g)).toEqual(
    original.match(/require \([\s\S]*?\n\)/g),
  );
  expect(starter).toContain(
    'replace galaxie.invalid/galaxie => ../node_modules/@galaxie-ai/starter-go/dist/go-module',
  );
  expect(await readFile('templates/frameworks/adk-go/files/go/go.sum')).toEqual(
    await readFile('go/go.sum'),
  );
});
test('Go author source has one home and no JavaScript bridge import', async () => {
  for (const file of await readdir('packages/starter-go', { recursive: true })) {
    if (file.endsWith('.go'))
      expect(await readFile(join('packages/starter-go', file), 'utf8')).not.toMatch(/package main/);
  }
  for (const file of ['main.go', 'agent.go']) {
    const text = await readFile(join('templates/frameworks/adk-go/files/go', file), 'utf8');
    expect(
      text.startsWith(
        '// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh\n// SPDX-License-Identifier: Apache-2.0',
      ),
    ).toBe(true);
    expect(text).not.toContain('syscall/js');
  }
});
test('build settings follow the Go lock and discard ambient overrides', async () => {
  const lock = JSON.parse(await readFile('go/wasm.lock', 'utf8'));
  expect(() => checkBuildSettings(lock)).not.toThrow();
  for (const key of ['toolchain', 'goos', 'goarch', 'cgo', 'flags', 'ldflags']) {
    const changed = structuredClone(lock);
    if (key === 'toolchain') changed.toolchain = 'go1.27.4';
    else changed.build[key] = 'changed';
    expect(() => checkBuildSettings(changed)).toThrow('drift');
  }
  const env = buildEnvironment({
    PATH: '/bin',
    HOME: '/home/test',
    GOFLAGS: '-race',
    GOENV: '/tmp/goenv',
    GOEXPERIMENT: 'x',
    SECRET: 'x',
  });
  expect(env).toEqual({
    PATH: '/bin',
    HOME: '/home/test',
    GOTOOLCHAIN: 'local',
    GOENV: 'off',
    GOOS: 'js',
    GOARCH: 'wasm',
    CGO_ENABLED: '0',
    GOWORK: 'off',
    GOWASM: '',
    GOEXPERIMENT: '',
    GOFLAGS: '-mod=readonly -trimpath -buildvcs=false',
  });
  expect(buildSettings.toolchain).toBe('go1.27.3');
});
test('the temporary starter passes native go vet', async (context) => {
  const version = spawnSync('go', ['env', 'GOVERSION'], {
    env: buildEnvironment(),
    encoding: 'utf8',
  });
  if (version.stdout?.trim() !== buildSettings.toolchain) {
    if (process.env['CI']) throw new Error('Go 1.27.3 is required in CI.');
    console.info('Skipping starter native vet: Go 1.27.3 is not on PATH.');
    context.skip();
    return;
  }
  const dir = await fixture();
  await rm(join(dir, 'main.go'));
  await cp('templates/frameworks/adk-go/files/go', join(dir, 'go'), { recursive: true });
  const module = join(dir, 'node_modules/@galaxie-ai/starter-go/dist/go-module');
  await mkdir(module, { recursive: true });
  await cp('go/galaxie', join(module, 'galaxie'), {
    recursive: true,
    filter: (p) => !p.endsWith('_test.go'),
  });
  for (const file of ['go.mod', 'go.sum']) await cp(join('go', file), join(module, file));
  const nativeOptions = {
    cwd: resolve(dir, 'go'),
    env: {
      ...buildEnvironment(),
      GOOS: process.platform === 'darwin' ? 'darwin' : 'linux',
      GOARCH: process.arch === 'arm64' ? 'arm64' : 'amd64',
    },
    encoding: 'utf8' as const,
  };
  // Keep cold-cache download progress separate from vet diagnostics.
  const download = spawnSync('go', ['mod', 'download'], { ...nativeOptions, timeout: 60_000 });
  const failures = download.stderr
    .trim()
    .split(/\r?\n/)
    .filter((line) => line !== '' && !/^go: downloading \S+ \S+$/.test(line));
  const first = failures[0] ?? '';
  const endpoint =
    first.match(/\b(?:Get|Head) "(https?:\/\/[^"]+)"/)?.[1] ??
    (first.includes('module lookup disabled by GOPROXY=off') ? 'off' : undefined);
  const transportFailure =
    failures.length > 0 &&
    failures.every(
      (line) =>
        line.includes('module lookup disabled by GOPROXY=off') ||
        (/\b(?:Get|Head) "https?:\/\/[^"]+"/.test(line) &&
          /\b(?:dial tcp|lookup .+:|network is unreachable|no route to host|TLS handshake timeout|i\/o timeout|connection refused|connection reset by peer)\b/.test(
            line,
          )),
    );
  if (download.status !== 0 && !process.env['CI'] && endpoint !== undefined && transportFailure) {
    const reason = await proxyOfflineReason(endpoint);
    if (reason) {
      console.info(`Skipping starter native vet: ${reason}`);
      context.skip(`Skipping starter native vet: ${reason}`);
      return;
    }
  }
  expect(download.status, download.stderr).toBe(0);
  const result = spawnSync('go', ['vet', '.'], nativeOptions);
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}, 120_000);

test('a symlink at the source tree root is refused', async () => {
  const parent = await fixture();
  const source = join(parent, 'source');
  await mkdir(source);
  await writeFile(join(source, 'main.go'), 'package main\n');
  const link = join(parent, 'linked-source');
  await symlink(source, link, 'dir');
  await expect(sourceHash(link, '0.0.0', 'module-a')).rejects.toThrow('symlink');
});

test.each([200, 404, 500])(
  'the offline probe preserves reachable proxy responses: HTTP %s',
  async (status) => {
    const server = createServer((_request, response) => {
      response.writeHead(status);
      response.end('{}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('Missing proxy port.');
      const probe = proxyOfflineReason(`http://127.0.0.1:${address.port}`);
      if (status === 200) expect(await probe).toBeUndefined();
      else await expect(probe).rejects.toThrow(`HTTP ${status}`);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);

test.each([
  { ci: false, failure: 'network' },
  { ci: true, failure: 'network' },
  { ci: false, failure: 'invalid-module' },
  { ci: false, failure: 'http' },
  { ci: false, failure: 'mixed-http' },
  { ci: false, failure: 'mixed-invalid' },
])(
  'native vet skips only transport failures outside CI: CI=$ci failure=$failure',
  async ({ ci, failure }) => {
    const dir = await fixture();
    const bin = join(dir, 'bin');
    await mkdir(bin);
    const server = createServer();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Missing proxy port.');
    await new Promise<void>((done) => server.close(() => done()));
    const endpoint = `http://127.0.0.1:${address.port}/google.golang.org/adk/@v/v1.9.0.info`;
    const network = `go: fixture.invalid/network: Get "${endpoint}": dial tcp 127.0.0.1: connect: connection refused`;
    const http = `go: fixture.invalid/http: Get "${endpoint}": 500 Internal Server Error`;
    const invalid = 'go: errors parsing go.mod: invalid module declaration';
    const diagnostics: Readonly<Record<string, string>> = {
      network,
      http,
      'invalid-module': invalid,
      'mixed-http': `${network}\n${http}`,
      'mixed-invalid': `${network}\n${invalid}`,
    };
    await writeFile(
      join(bin, 'go'),
      `#!${process.execPath}
if(process.argv[2] === 'env') process.stdout.write('go1.27.3\\n');
else {
  process.stderr.write(${JSON.stringify(`${diagnostics[failure]}\n`)});
  process.exit(1);
}
`,
      { mode: 0o755 },
    );
    const child = spawnSync(
      process.execPath,
      [
        resolve('node_modules/vitest/vitest.mjs'),
        'run',
        '--project',
        'node',
        '--reporter=verbose',
        'tests/conformance/starter-go-source.node.test.ts',
        '-t',
        '^the temporary starter passes native go vet$',
      ],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          GOPROXY: `http://127.0.0.1:${address.port}`,
          CI: ci ? '1' : '',
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    const output = child.stdout + child.stderr;
    expect(child.error).toBeUndefined();
    if (ci || failure !== 'network') {
      expect(child.status).not.toBe(0);
      expect(output).toContain(diagnostics[failure]);
    } else {
      expect(child.status, output).toBe(0);
      expect(output).toContain(
        'Skipping starter native vet: the configured Go module proxy is unreachable.',
      );
    }
  },
);

test('an unquoted replace target is cut at an attached comment marker like Go does', async () => {
  // The unquoted token normalizes to a path inside go/, but Go reads it as ../external.
  const root = await fixture();
  const dir = join(root, 'go');
  await mkdir(dir);
  await writeFile(join(dir, 'main.go'), 'package main\n');
  await writeFile(
    join(dir, 'go.mod'),
    'module example.invalid/starter\nreplace example.invalid/module => ../external//../go/x\n',
  );
  await expect(sourceHash(dir, '0.2.0', 'module')).rejects.toThrow('local replace target');
});

test.each(['"\\u002e\\u002e/external"', '"\\x2e./external"'])(
  'a quoted replace target with escapes is decoded or refused, never trusted: %s',
  async (target) => {
    const dir = await fixture();
    await writeFile(
      join(dir, 'go.mod'),
      `module example.invalid/starter\nreplace example.invalid/module => ${target}\n`,
    );
    await expect(sourceHash(dir, '0.2.0', 'module')).rejects.toThrow();
  },
);

test.each([
  '../external',
  '/tmp/external-go-module',
  '../node_modules/unhashed-module',
  './node_modules/unhashed-module',
  './NODE_MODULES/unhashed-module',
  './.GiT/unhashed-module',
  './.ds_store/unhashed-module',
  './.git/unhashed-module',
  './nested/../../external',
])('local replacement outside the source identity is refused before Go: %s', async (target) => {
  const dir = await fixture();
  for (const declaration of [
    `replace example.invalid/module => ${target}`,
    `replace (\nexample.invalid/module v1.0.0 => "${target}" // local module\n)`,
    `replace (\nexample.invalid/module => \`${target}\`\n)`,
  ]) {
    await writeFile(join(dir, 'go.mod'), `module example.invalid/starter\n${declaration}\n`);
    await expect(sourceHash(dir, '0.2.0', 'module')).rejects.toThrow('local replace target');
    await expect(buildAgent(dir, join(dir, 'agent.wasm'), { PATH: '' })).rejects.toThrow(
      'local replace target',
    );
  }
});

test('hashed local modules and the bundled module replacement stay usable without Go', async () => {
  const dir = await fixture();
  await mkdir(join(dir, 'local'));
  const local = join(dir, 'local/lib.go');
  await writeFile(local, 'package local\n');
  await writeFile(
    join(dir, 'go.mod'),
    `module example.invalid/starter
// replace ignored.invalid/module => ../ignored
replace (
  example.invalid/local => "./local"
  galaxie.invalid/galaxie => ../node_modules/@galaxie-ai/starter-go/dist/go-module
  example.invalid/remote => example.invalid/replacement v1.0.0
)
`,
  );
  const original = await sourceHash(dir, '0.2.0', 'module');
  await writeFile(local, 'package local\n// changed\n');
  expect(await sourceHash(dir, '0.2.0', 'module')).not.toBe(original);
});
