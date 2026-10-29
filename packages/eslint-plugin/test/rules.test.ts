// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { type Rule, RuleTester } from 'eslint';
import { describe, expect, it } from 'vitest';
import { globalPath, isDynamicGlobal } from '../src/globals.js';
import galaxie from '../src/index.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const probe: Rule.RuleModule = {
  meta: { schema: [], messages: { global: '{{name}}', dynamicGlobal: 'dynamic' } },
  create(context) {
    return {
      Identifier(node) {
        const path = globalPath(context, node);
        if (path?.[0] === 'fetch')
          context.report({ node, messageId: 'global', data: { name: 'fetch' } });
      },
      MemberExpression(node) {
        if (isDynamicGlobal(context, node)) context.report({ node, messageId: 'dynamicGlobal' });
        else if (globalPath(context, node)?.join('.') === 'fetch')
          context.report({ node, messageId: 'global', data: { name: 'fetch' } });
      },
    };
  },
};

tester.run('global resolution', probe, {
  valid: [
    'function run(fetch) { fetch(); }',
    'import { fetch } from "local"; fetch();',
    'const window = {}; window.fetch();',
    'function run(globalThis) { globalThis[key](); }',
    'const obj = { fetch() {} }; obj.fetch();',
    'fetch(); function fetch() {}',
    'const { fetch } = source; fetch();',
    'const obj = { fetch: 1 };',
  ],
  invalid: [
    { code: 'fetch();', errors: [{ messageId: 'global', data: { name: 'fetch' } }] },
    {
      code: 'fetch();',
      languageOptions: { globals: { fetch: 'readonly' } },
      errors: [{ messageId: 'global', data: { name: 'fetch' } }],
    },
    ...['globalThis.fetch', 'window["fetch"]', 'self.fetch', 'globalThis.window.fetch'].map(
      (access) => ({ code: `${access}();`, errors: [{ messageId: 'global' }] }),
    ),
    { code: 'globalThis[key]();', errors: [{ messageId: 'dynamicGlobal' }] },
    { code: 'self.window[key]();', errors: [{ messageId: 'dynamicGlobal' }] },
  ],
});

it('keeps plugin metadata and the recommended config aligned', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(galaxie.meta.version).toBe(manifest.version);
  expect(galaxie.meta.name).toBe('@galaxie/eslint-plugin');
  expect(galaxie.configs.recommended.plugins?.['galaxie']).toBe(galaxie);
  expect(galaxie.configs.recommended.rules).toEqual(
    Object.fromEntries(Object.keys(galaxie.rules).map((name) => [`galaxie/${name}`, 'error'])),
  );
});
