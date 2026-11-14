// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
beforeAll(() =>
  execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.scripts.json'], { cwd: root }),
);

test.each([true, false])(
  'teardown pins its project and environment with .env present=%s',
  (present) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'galaxie-llmops-lifecycle-')));
    try {
      const bin = join(directory, 'bin');
      mkdirSync(bin);
      cpSync(join(root, 'dist'), join(directory, 'dist'), { recursive: true });
      cpSync(join(root, 'compose.yaml'), join(directory, 'compose.yaml'));
      cpSync(join(root, '.env.example'), join(directory, '.env.example'));
      writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
      if (present)
        writeFileSync(
          join(directory, '.env'),
          'LANGFUSE_OTEL_ENDPOINT=http://langfuse-web:3000/api/public/otel\nMLFLOW_EXPERIMENT_ID=1\n',
          { mode: 0o600 },
        );
      const capture = join(directory, 'capture.json');
      writeFileSync(
        join(bin, 'docker'),
        `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LLMOPS_DOCKER_CAPTURE, JSON.stringify({args:process.argv.slice(2), endpoint:process.env.LANGFUSE_OTEL_ENDPOINT}));
`,
        { mode: 0o755 },
      );
      execFileSync(process.execPath, [join(directory, 'dist/stack.js'), 'down'], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH']}`,
          LLMOPS_DOCKER_CAPTURE: capture,
          LANGFUSE_OTEL_ENDPOINT: 'http://127.0.0.1:1',
          COMPOSE_PROJECT_NAME: 'unrelated-project',
          COMPOSE_FILE: join(directory, 'unrelated-compose.yaml'),
        },
        stdio: 'pipe',
      });
      expect(existsSync(capture), 'teardown must invoke Docker even without .env').toBe(true);
      const observed = JSON.parse(readFileSync(capture, 'utf8')) as {
        args: string[];
        endpoint: string;
      };
      expect(observed.args).toEqual([
        'compose',
        '--project-name',
        'galaxie-llmops-trace-sinks',
        '--file',
        join(directory, 'compose.yaml'),
        '--env-file',
        join(directory, present ? '.env' : '.env.example'),
        'down',
        '-v',
        '--remove-orphans',
      ]);
      expect(observed.endpoint).toBe(present ? 'http://langfuse-web:3000/api/public/otel' : '');
      if (present)
        expect(readFileSync(join(directory, '.env'), 'utf8')).toContain('MLFLOW_EXPERIMENT_ID=\n');
      else expect(existsSync(join(directory, '.env'))).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
