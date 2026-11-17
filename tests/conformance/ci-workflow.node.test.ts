// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const jobs = new Map(
  workflow
    .slice(workflow.indexOf('\njobs:\n'))
    .split(/^ {2}(?=[a-z][\w-]*:\s*$)/m)
    .slice(1)
    .map((block) => [block.slice(0, block.indexOf(':')), block]),
);

function job(name: string): string {
  const block = jobs.get(name);
  if (block === undefined) throw new Error(`Missing CI job: ${name}`);
  return block;
}

test('create-clean is scoped, bounded and uses pinned external actions', () => {
  const block = job('create-clean');
  expect(block).toMatch(/^ {4}needs: \[scope\]$/m);
  expect(block).toContain("if: needs.scope.outputs.create == 'true'");
  expect(block).toContain('runs-on: ubuntu-24.04');
  expect(block).toContain('timeout-minutes: 45');
  expect(block).toContain('persist-credentials: false');
  const actions = [...block.matchAll(/^\s+(?:- )?uses: (.+)$/gm)].map((match) => match[1]);
  expect(actions.length).toBeGreaterThan(0);
  for (const action of actions) {
    if (action?.startsWith('./')) continue;
    expect(action).toMatch(/^[\w./-]+@[a-f0-9]{40} # v\S+$/);
  }
  expect(block).toContain('uses: ./.github/actions/setup');
  expect(block).toContain("go: ${{ matrix.framework == 'adk-go' }}");
  expect(block).toContain("python: ${{ matrix.framework == 'langgraph-python' }}");
  expect(block).toContain('browser: "true"');
});

test('create-clean has four Node 24 frameworks and a separate LangGraph Node 22 leg', () => {
  const block = job('create-clean');
  expect(block).toContain('fail-fast: false');
  expect(block).toContain('name: create-clean (${{ matrix.framework }} node ${{ matrix.node }})');
  const frameworks = /framework: \[([^\]]+)\]/.exec(block)?.[1]?.split(/,\s*/);
  expect(frameworks).toEqual(['langgraph-js', 'adk-js', 'adk-go', 'langgraph-python']);
  expect(block).toMatch(/^ {8}node: \[24\]$/m);
  expect(block).toMatch(/^ {8}include:\n {10}- framework: langgraph-js\n {12}node: 22\n {4}name:/m);
});

test('create-clean captures Node 22 and provisions npm after restoring the repository Node', () => {
  const block = job('create-clean');
  const capture = block.indexOf('id: node22');
  const restore = block.indexOf('node-version-file: .nvmrc');
  const npm = block.indexOf('npm install -g npm@12.2.2');
  expect(capture).toBeGreaterThan(0);
  expect(block).toContain('node-version: "22"');
  expect(block).toContain('echo "path=$(command -v node)" >> "$GITHUB_OUTPUT"');
  expect(restore).toBeGreaterThan(capture);
  expect(npm).toBeGreaterThan(restore);
  expect(block).toContain('test "$(npm --version)" = "12.2.2"');
  expect(block).toContain('NODE_22: ${{ steps.node22.outputs.path }}');
  expect(block).toContain('args+=(--node "22=$NODE_22")');
});

test('create-clean warms framework artifacts and runs both kinds with a clean PATH and budget', () => {
  const block = job('create-clean');
  expect(block).toMatch(
    /if: matrix.framework == 'adk-go'\n {8}run: pnpm --filter @galaxie-ai\/starter-go run prepack/,
  );
  expect(block).toMatch(
    /if: matrix.framework == 'langgraph-python'\n {8}run: \|\n {10}pnpm exec tsc -p packages\/ui-protocol\/tsconfig.build.json\n {10}pnpm exec tsc -p packages\/core\/tsconfig.build.json\n {10}pnpm exec tsc -p packages\/adapter-kit\/tsconfig.build.json\n {10}pnpm exec tsc -p packages\/adapter-pyodide\/tsconfig.build.json\n {10}pnpm --filter @galaxie-ai\/starter-python run prepack/,
  );
  expect(block).toContain('pnpm exec tsc -p packages/create/tsconfig.build.json');
  expect(block).toContain('node scripts/verify-standalone.ts');
  expect(block).toContain('--framework "$FRAMEWORK" --kind all --mode tarball');
  expect(block).toContain(
    '--clean-path --budget-minutes 10 --json "$RUNNER_TEMP/create-clean.json"',
  );
  expect(block).toContain('FRAMEWORK: ${{ matrix.framework }}');
});

test('create-clean always logs JSON and writes per-project durations without another action', () => {
  const block = job('create-clean');
  const summary = block.slice(block.indexOf('if: always()'));
  expect(summary).toContain('cat "$RUNNER_TEMP/create-clean.json"');
  expect(summary).toContain('GITHUB_STEP_SUMMARY');
  expect(summary).toContain('durationMs');
  expect(summary).toContain('JSON.parse');
  expect(summary).not.toContain('uses:');
});

test('python-rest runs the starter files once with the Go step file-parallelism limit', () => {
  const block = job('test-python');
  expect(block).not.toContain('tests/conformance/starter-python-*.node.test.ts');
  expect(block).toContain(`      - name: Test the Python group once
        run: |
          args=()
          if [ "$GALAXIE_TEST_GROUP" = "python-rest" ]; then
            args+=(--no-file-parallelism)
          fi
          CI=true pnpm test "\${args[@]}"
        env:
          GALAXIE_TEST_GROUP: \${{ matrix.group }}`);
  expect([...block.matchAll(/pnpm test/g)]).toHaveLength(1);
  expect(job('go')).toContain(
    'pnpm exec vitest run --project node tests/conformance/starter-go-*.node.test.ts --no-file-parallelism',
  );
});

test('scope exposes create and both early exits conservatively enable both job groups', () => {
  const block = job('scope');
  expect(block).toContain('create: ${{ steps.scope.outputs.create }}');
  expect(block).toContain('python: ${{ steps.scope.outputs.python }}');
  const exits = [
    ...block.matchAll(/(if \[ "\$EVENT"[^\n]+|files=\$\(git diff[^\n]+)\n([\s\S]*?)exit 0/g),
  ];
  expect(exits).toHaveLength(2);
  for (const exit of exits) {
    expect(exit[2]).toContain('echo "python=true" >> "$GITHUB_OUTPUT"');
    expect(exit[2]).toContain('echo "create=true" >> "$GITHUB_OUTPUT"');
  }
  expect(block).toContain('node scripts/ci-scope.ts | tee -a "$GITHUB_OUTPUT"');
});

test('nextjs runs the example unconditionally with Chromium and pinned external actions', () => {
  const block = job('nextjs');
  expect(block).toContain('runs-on: ubuntu-24.04');
  expect(block).toContain('timeout-minutes: 45');
  expect(block).not.toMatch(/^ {4}(?:if|needs):/m);
  expect(block).toContain('persist-credentials: false');
  const actions = [...block.matchAll(/^\s+(?:- )?uses: (.+)$/gm)].map((match) => match[1]);
  expect(actions.length).toBeGreaterThan(0);
  for (const action of actions) {
    if (action?.startsWith('./')) continue;
    expect(action).toMatch(/^[\w./-]+@[a-f0-9]{40} # v\S+$/);
  }
  expect(block).toContain('uses: ./.github/actions/setup');
  expect(block).toContain('browser: "true"');
  expect(block).not.toMatch(/^\s+(?:go|python):/m);
  expect(block).toContain('run: pnpm --filter @galaxie-ai/example-nextjs-app-router test');
});

test('the final ci gate depends on every other job, including create-clean and nextjs', () => {
  const needs = /^ {4}needs:\s*\[([^\]]+)\]/m.exec(job('ci'))?.[1];
  expect(needs).toBeDefined();
  const dependencies =
    needs
      ?.split(',')
      .map((name) => name.trim())
      .filter(Boolean) ?? [];
  expect(dependencies).toContain('create-clean');
  expect(dependencies).toContain('nextjs');
  expect(dependencies.sort()).toEqual([...jobs.keys()].filter((name) => name !== 'ci').sort());
});
