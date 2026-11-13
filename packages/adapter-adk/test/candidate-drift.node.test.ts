// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('candidate is exactly the shipped adapter plus its three marked substitutions', () => {
  const source = readFileSync(new URL('../src/adapter.ts', import.meta.url), 'utf8');
  const candidate = readFileSync(
    new URL('./support/candidate-adapter.ts', import.meta.url),
    'utf8',
  );
  const substitutions = [
    {
      number: 3,
      start: 'export function createAdkAdapter(): ExecutorAdapter<AdkAgent, AdkServices> {',
      end: '      /** Reads the stored conversation once, registering its content as private before replay. */',
      sha256: '0eae55289e908eefdc23f13feabee6eb8b2af892fdbaec4c364a75146dcff2df',
    },
    {
      number: 2,
      start: '            if (\n              stored.pause !== undefined &&',
      end: "            if (register === undefined) throw failure('unsupported');",
      sha256: '425e5c62030200568fa21cee313fab2eee98c3cc2acc7c341539103673650c18',
    },
    {
      number: 1,
      start:
        "          let message: { role: 'user'; parts: { text: string }[] } | ReturnType<typeof answerOf>;",
      end: '              } catch (error) {\n                run.fail(error);',
      sha256: '7fdd6e2aafe79626eaf40949d027e3ff83d0e83ead92eb096ca1fcb9c606c578',
    },
  ];
  let rebuilt = source;
  expect(candidate.match(/CANDIDATE-BEGIN /g)).toHaveLength(3);
  expect(candidate.match(/CANDIDATE-END /g)).toHaveLength(3);
  for (const substitution of substitutions) {
    const start = source.indexOf(substitution.start);
    const end = source.indexOf(substitution.end, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const original = source.slice(start, end);
    expect(createHash('sha256').update(original).digest('hex')).toBe(substitution.sha256);
    const marked = candidate.match(
      new RegExp(
        `^[ ]*// CANDIDATE-BEGIN ${substitution.number}\\n[\\s\\S]*?^[ ]*// CANDIDATE-END ${substitution.number}\\n`,
        'gm',
      ),
    );
    expect(marked).toHaveLength(1);
    rebuilt = rebuilt.replace(original, marked?.[0] ?? '');
  }
  rebuilt = rebuilt.replaceAll("from './", "from '../../src/");
  expect(candidate).toBe(rebuilt);
});
