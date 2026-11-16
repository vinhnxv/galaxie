// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { expect, onTestFinished, test } from 'vitest';
import type { InstallCommand } from '../src/install.js';
import { run } from '../src/main.js';

async function fixture(): Promise<{ root: string; templatesRoot: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'galaxie-cli-')));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const templatesRoot = join(root, 'layers');
  for (const [path, id, type, packageFragment, files] of [
    [
      'base',
      'base',
      'base',
      { version: '0.0.0', private: true, license: 'Apache-2.0' },
      { _gitignore: 'node_modules/\n', 'AGENTS.md': 'generated instructions\n' },
    ],
    [
      'kinds/browser-only',
      'browser-only',
      'kind',
      { dependencies: { '@galaxie-ai/core': '^0.1.0' } },
      { 'main.txt': 'main\n' },
    ],
    [
      'frameworks/langgraph-js',
      'langgraph-js',
      'framework',
      { dependencies: { zod: '4.6.7' } },
      { 'agent.txt': 'agent\n' },
    ],
  ] as const) {
    await mkdir(join(templatesRoot, path, 'files'), { recursive: true });
    await writeFile(
      join(templatesRoot, path, 'layer.json'),
      JSON.stringify({
        schema: 1,
        id,
        type,
        package: packageFragment,
        ...(type === 'kind' ? { frameworks: ['langgraph-js'] } : {}),
      }),
    );
    for (const [name, bytes] of Object.entries(files))
      await writeFile(join(templatesRoot, path, 'files', name), bytes);
  }
  return { root, templatesRoot };
}

function output(): {
  stdout: PassThrough;
  stderr: PassThrough;
  text: () => string;
  errors: () => string;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let text = '';
  let errors = '';
  stdout.on('data', (bytes: Buffer) => {
    text += bytes.toString();
  });
  stderr.on('data', (bytes: Buffer) => {
    errors += bytes.toString();
  });
  return { stdout, stderr, text: () => text, errors: () => errors };
}

test.each([
  ['my-app', 'browser-only', 'langgraph-js', '--no-install'],
  ['--kind', 'browser-only', '--framework', 'langgraph-js', '--no-install', 'my-app'],
])('writes the fixed project oracle for either argument form: %j', async (...argv) => {
  const { root, templatesRoot } = await fixture();
  const streams = output();
  let installs = 0;
  expect(
    await run(argv, {
      cwd: root,
      templatesRoot,
      ...streams,
      env: {},
      runner: async () => {
        installs++;
      },
    }),
  ).toBe(0);
  expect(installs).toBe(0);
  expect((await readdir(join(root, 'my-app'))).sort()).toEqual([
    '.gitignore',
    'AGENTS.md',
    'agent.txt',
    'main.txt',
    'package.json',
  ]);
  expect(await readFile(join(root, 'my-app/main.txt'), 'utf8')).toBe('main\n');
  expect(await readFile(join(root, 'my-app/agent.txt'), 'utf8')).toBe('agent\n');
  expect(await readFile(join(root, 'my-app/.gitignore'), 'utf8')).toBe('node_modules/\n');
  expect(await readFile(join(root, 'my-app/AGENTS.md'), 'utf8')).toBe('generated instructions\n');
  expect(JSON.parse(await readFile(join(root, 'my-app/package.json'), 'utf8'))).toEqual({
    name: 'my-app',
    version: '0.0.0',
    private: true,
    license: 'Apache-2.0',
    dependencies: { '@galaxie-ai/core': '^0.1.0', zod: '4.6.7' },
  });
  expect(streams.text()).toContain('Created 5 files');
  expect(streams.text()).toContain('npm install --ignore-scripts');
  expect(streams.errors()).toBe('');
});

test.each([
  ['my-app'],
  ['my-app', 'browser-only'],
  ['--kind', 'browser-only', '--framework', 'langgraph-js'],
  ['my-app', 'wrong', 'langgraph-js'],
  ['my-app', 'browser-only', 'wrong'],
  ['--unknown'],
])('non-TTY missing or invalid choices exit 2 before writing: %j', async (...argv) => {
  const { root, templatesRoot } = await fixture();
  const streams = output();
  expect(
    await run(argv, { cwd: root, templatesRoot, ...streams, env: {}, stdin: new PassThrough() }),
  ).toBe(2);
  expect(streams.errors()).toContain('Valid kinds: browser-only');
  expect(streams.errors()).toContain('Valid frameworks: langgraph-js');
  expect(await readdir(root)).toEqual(['layers']);
});

test('TTY prompts accept numeric choices, names and Enter for a singleton', async () => {
  const { root, templatesRoot } = await fixture();
  const streams = output();
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  Object.assign(streams.stdout, { isTTY: true });
  const task = run(['--no-install'], { cwd: root, templatesRoot, stdin, ...streams, env: {} });
  setImmediate(() => {
    stdin.end('my-app\n1\nlanggraph-js\n');
  });
  expect(await task).toBe(0);
  expect(streams.text()).toContain('Project directory');
  expect(streams.text()).toContain('Kind');
  expect(streams.text()).toContain('Framework');
  const secondInput = Object.assign(new PassThrough(), { isTTY: true });
  const second = run(['another-app', 'browser-only', '--no-install'], {
    cwd: root,
    templatesRoot,
    stdin: secondInput,
    ...streams,
    env: {},
  });
  setImmediate(() => {
    secondInput.end('\n');
  });
  expect(await second).toBe(0);
});

test.each(['eof', 'invalid'] as const)('TTY %s exits 2 and writes nothing', async (kind) => {
  const { root, templatesRoot } = await fixture();
  const streams = output();
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  Object.assign(streams.stdout, { isTTY: true });
  const task = run(['my-app', '--no-install'], {
    cwd: root,
    templatesRoot,
    stdin,
    ...streams,
    env: {},
  });
  setImmediate(() => {
    stdin.end(kind === 'eof' ? '' : 'wrong\nwrong\nwrong\n');
  });
  expect(await task).toBe(2);
  expect(existsSync(join(root, 'my-app'))).toBe(false);
});

test.each(['npm', 'pnpm', 'yarn', 'bun'] as const)(
  'the CLI installs with the detected manager (%s)',
  async (manager) => {
    const { root, templatesRoot } = await fixture();
    const streams = output();
    const commands: InstallCommand[] = [];
    const env = { npm_config_user_agent: `${manager}/1.0` };
    expect(
      await run(['my-app', 'browser-only', 'langgraph-js'], {
        cwd: root,
        templatesRoot,
        ...streams,
        env,
        platform: 'darwin',
        runner: async (command) => {
          commands.push(command);
        },
      }),
    ).toBe(0);
    expect(commands).toEqual([
      {
        executable: manager === 'bun' ? 'npm' : manager,
        args: ['install', '--ignore-scripts'],
        cwd: join(root, 'my-app'),
        env,
        shell: false,
      },
    ]);
    if (manager === 'bun')
      expect(streams.text()).toContain('Unrecognized package manager; using npm.');
  },
);

test('Windows prints its install command; a failed install retains the project and returns 1', async () => {
  const { root, templatesRoot } = await fixture();
  const streams = output();
  let calls = 0;
  const runner = async (): Promise<void> => {
    calls++;
    throw new Error('document-value-canary');
  };
  expect(
    await run(['my-app', 'browser-only', 'langgraph-js'], {
      cwd: root,
      templatesRoot,
      ...streams,
      env: {},
      platform: 'win32',
      runner,
    }),
  ).toBe(0);
  expect(calls).toBe(0);
  expect(streams.text()).toContain('npm install --ignore-scripts');
  expect(
    await run(['failed-app', 'browser-only', 'langgraph-js'], {
      cwd: root,
      templatesRoot,
      ...streams,
      env: {},
      platform: 'darwin',
      runner,
    }),
  ).toBe(1);
  expect(existsSync(join(root, 'failed-app/package.json'))).toBe(true);
  expect(streams.errors()).toContain('npm install --ignore-scripts');
  expect(streams.errors()).not.toContain('document-value-canary');
});

test('existing instruction files are kept and an ordinary collision aborts every write', async () => {
  const { root, templatesRoot } = await fixture();
  const streams = output();
  await mkdir(join(root, 'my-app'));
  await writeFile(join(root, 'my-app/agents.md'), 'host instructions\n');
  expect(
    await run(['my-app', 'browser-only', 'langgraph-js', '--no-install'], {
      cwd: root,
      templatesRoot,
      ...streams,
      env: {},
    }),
  ).toBe(0);
  expect(await readFile(join(root, 'my-app/agents.md'), 'utf8')).toBe('host instructions\n');
  expect(streams.text()).toContain('Kept existing AGENTS.md');
  await mkdir(join(root, 'blocked-app'));
  await writeFile(join(root, 'blocked-app/package.json'), 'existing\n');
  expect(
    await run(['blocked-app', 'browser-only', 'langgraph-js', '--no-install'], {
      cwd: root,
      templatesRoot,
      ...streams,
      env: {},
    }),
  ).toBe(1);
  expect(await readdir(join(root, 'blocked-app'))).toEqual(['package.json']);
  expect(streams.errors()).toContain('Existing output paths: package.json');
});

test.each(['../escape', '/absolute-app', 'bad\0name', 'Uppercase', '.hidden', 'has spaces'])(
  'invalid project targets fail before writes: %j',
  async (directory) => {
    const { root, templatesRoot } = await fixture();
    const streams = output();
    expect(
      await run([directory, 'browser-only', 'langgraph-js', '--no-install'], {
        cwd: root,
        templatesRoot,
        ...streams,
        env: {},
      }),
    ).toBe(2);
    expect(await readdir(root)).toEqual(['layers']);
  },
);

test('a symlink target is refused after a real target succeeds', async () => {
  const { root, templatesRoot } = await fixture();
  const streams = output();
  await mkdir(join(root, 'actual-app'));
  await symlink(join(root, 'actual-app'), join(root, 'linked-app'));
  expect(
    await run(['linked-app', 'browser-only', 'langgraph-js', '--no-install'], {
      cwd: root,
      templatesRoot,
      ...streams,
      env: {},
    }),
  ).toBe(1);
  expect(await readdir(join(root, 'actual-app'))).toEqual([]);
  expect(
    await run(['actual-app', 'browser-only', 'langgraph-js', '--no-install'], {
      cwd: root,
      templatesRoot,
      ...streams,
      env: {},
    }),
  ).toBe(0);
});

test('a dot target uses the current directory name and help performs no write', async () => {
  const { root, templatesRoot } = await fixture();
  const streams = output();
  expect(await run(['--help'], { cwd: root, templatesRoot, ...streams, env: {} })).toBe(0);
  expect(await readdir(root)).toEqual(['layers']);
  const cwd = join(root, 'current-app');
  await mkdir(cwd);
  expect(
    await run(['.', 'browser-only', 'langgraph-js', '--no-install'], {
      cwd,
      templatesRoot,
      ...streams,
      env: {},
    }),
  ).toBe(0);
  expect(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).name).toBe('current-app');
});

test.each(['pnpm', 'npm', 'yarn', 'bun'])(
  'the %s ADK CLI emits build decisions only for pnpm',
  async (manager) => {
    const { root } = await fixture();
    const streams = output();
    expect(
      await run(['adk-app', 'browser-only', 'adk-js', '--no-install'], {
        cwd: root,
        templatesRoot: fileURLToPath(new URL('../../../templates', import.meta.url)),
        ...streams,
        env: { npm_config_user_agent: `${manager}/11` },
      }),
    ).toBe(0);
    const yaml = join(root, 'adk-app/pnpm-workspace.yaml');
    expect(existsSync(yaml)).toBe(manager === 'pnpm');
    if (manager === 'pnpm')
      expect(await readFile(yaml, 'utf8')).toBe(
        "allowBuilds:\n  '@google/genai': false\n  cpu-features: false\n  protobufjs: false\n  ssh2: false\n",
      );
  },
);

test('the ADK CLI warns that the adapter is unpublished unless packed tarballs are supplied', async () => {
  const { root } = await fixture();
  const streams = output();
  expect(
    await run(['adk-app', 'browser-only', 'adk-js', '--no-install'], {
      cwd: root,
      templatesRoot: fileURLToPath(new URL('../../../templates', import.meta.url)),
      ...streams,
      env: { npm_config_user_agent: 'npm/11' },
    }),
  ).toBe(0);
  expect(streams.text()).toContain('@galaxie-ai/adapter-adk is not published yet');
});

test.each(['browser-only', 'gateway'])(
  'the %s ADK Go CLI warns about both unpublished packages and emits the Go source',
  async (kind) => {
    const { root } = await fixture();
    const streams = output();
    expect(
      await run(['go-app', kind, 'adk-go', '--no-install'], {
        cwd: root,
        templatesRoot: fileURLToPath(new URL('../../../templates', import.meta.url)),
        ...streams,
        env: {},
      }),
    ).toBe(0);
    expect(streams.text()).toContain(
      '@galaxie-ai/adapter-go and @galaxie-ai/starter-go are not published yet',
    );
    expect(await readdir(join(root, 'go-app/go'))).toEqual([
      'agent.go',
      'go.mod',
      'go.sum',
      'main.go',
    ]);
  },
);

test.each(['browser-only', 'gateway'])(
  'the %s LangGraph Python CLI warns about both unpublished packages and emits the Python source',
  async (kind) => {
    const { root } = await fixture();
    const streams = output();
    expect(
      await run(['python-app', kind, 'langgraph-python', '--no-install'], {
        cwd: root,
        templatesRoot: fileURLToPath(new URL('../../../templates', import.meta.url)),
        ...streams,
        env: {},
      }),
    ).toBe(0);
    expect(streams.text()).toContain(
      '@galaxie-ai/adapter-pyodide and @galaxie-ai/starter-python are not published yet',
    );
    expect(await readdir(join(root, 'python-app/python/agent/starter_agent'))).toEqual([
      '__init__.py',
      'graph.py',
    ]);
  },
);
