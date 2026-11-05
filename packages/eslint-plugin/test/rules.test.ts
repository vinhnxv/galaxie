// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { Linter, type Rule, RuleTester } from 'eslint';
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

function invalid(code: string, messageId: string, name?: string): RuleTester.InvalidTestCase {
  return { code, errors: [{ messageId, ...(name === undefined ? {} : { data: { name } }) }] };
}

function rule(name: string): Rule.RuleModule {
  const result = galaxie.rules[name];
  if (result === undefined) throw new Error(`Missing rule: ${name}`);
  return result;
}

const roots = ['globalThis', 'window', 'self', 'global', 'globalThis.window', 'self.globalThis'];
const networkNames = [
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'WebTransport',
  'RTCPeerConnection',
  'importScripts',
];

tester.run('no-direct-network', rule('no-direct-network'), {
  valid: [
    ...networkNames.map((name) => `function run(${name}) { ${name}(); }`),
    'import { fetch } from "local"; fetch();',
    'const obj = { fetch() {} }; obj.fetch();',
    'const window = {}; window.fetch();',
    'function run(navigator) { navigator.sendBeacon("payload"); }',
    'const globalThis = {}; globalThis.fetch();',
  ],
  invalid: [
    ...networkNames.map((name) =>
      invalid(
        name === 'fetch' || name === 'importScripts'
          ? `${name}("private");`
          : `new ${name}("private");`,
        'directNetwork',
        name,
      ),
    ),
    ...roots.flatMap((root) => [
      invalid(`${root}.fetch("private");`, 'directNetwork', 'fetch'),
      invalid(`${root}['fetch']("private");`, 'directNetwork', 'fetch'),
      invalid(`new ${root}['WebSocket']("private");`, 'directNetwork', 'WebSocket'),
      invalid(
        `${root}.navigator['sendBeacon']("private");`,
        'directNetwork',
        'navigator.sendBeacon',
      ),
    ]),
    invalid('navigator.sendBeacon("private");', 'directNetwork', 'navigator.sendBeacon'),
    invalid('fetch?.("private");', 'directNetwork', 'fetch'),
    invalid('const f = fetch;', 'directNetwork', 'fetch'),
    invalid('const f = globalThis.fetch;', 'directNetwork', 'fetch'),
  ],
});

const storageNames = ['localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore'];
tester.run('no-direct-storage', rule('no-direct-storage'), {
  valid: [
    ...storageNames.map((name) => `function run(${name}) { return ${name}; }`),
    'import { document } from "local"; document.cookie;',
    'const obj = {}; obj.localStorage;',
    'function run(navigator) { navigator.storage; }',
    'const window = {}; window.localStorage;',
  ],
  invalid: [
    ...storageNames.map((name) => invalid(`const value = ${name};`, 'directStorage', name)),
    ...roots.flatMap((root) =>
      storageNames.map((name) => invalid(`${root}['${name}'];`, 'directStorage', name)),
    ),
    invalid('document.cookie = "private";', 'directStorage', 'document.cookie'),
    invalid('globalThis.document["cookie"];', 'directStorage', 'document.cookie'),
    invalid('navigator.storage.persist();', 'directStorage', 'navigator.storage'),
    invalid('window.navigator["storage"];', 'directStorage', 'navigator.storage'),
  ],
});

tester.run('no-dom', rule('no-dom'), {
  valid: [
    'import { document } from "local"; document.querySelector("x");',
    'const window = {}; window.fetch();',
    'function run(document, navigator, DOMParser, HTMLElement) { return [document, navigator, DOMParser, HTMLElement]; }',
    'element.textContent = value;',
    'const obj = {}; obj.document; obj.write(value); obj.innerHTML;',
    'window.fetch("private"); document.cookie; navigator.storage; navigator.sendBeacon("private");',
    'globalThis.window.fetch(); self.window.localStorage;',
    'window.document.cookie; globalThis.window.navigator.storage;',
    'const globalThis = {}; globalThis[key];',
    'globalThis[1];',
    'const element = <div title={value}>{value}</div>;',
  ],
  invalid: [
    ...['document', 'window', 'DOMParser', 'HTMLElement', 'navigator'].map((name) =>
      invalid(`const value = ${name};`, 'domAccess', name),
    ),
    ...roots.map((root) => invalid(`${root}['document'].body;`, 'domAccess', 'document')),
    invalid('document.querySelector("private");', 'domAccess', 'document'),
    invalid('navigator.language;', 'domAccess', 'navigator'),
    invalid('window.document.body;', 'domAccess', 'document'),
    invalid('window.location;', 'domAccess', 'window'),
    ...['innerHTML', 'outerHTML', 'srcdoc'].flatMap((name) => [
      invalid(`element.${name} = "private";`, 'htmlSink', name),
      invalid(`element['${name}'] += value;`, 'htmlSink', name),
    ]),
    ...['insertAdjacentHTML', 'createContextualFragment'].flatMap((name) => [
      invalid(`element.${name}("private");`, 'htmlSink', name),
      invalid(`element['${name}'](value);`, 'htmlSink', name),
    ]),
    ...['write', 'writeln'].flatMap((name) => [
      invalid(`document.${name}("private");`, 'htmlSink', name),
      invalid(`globalThis.window.document['${name}'](value);`, 'htmlSink', name),
    ]),
    invalid('document.body.innerHTML = value;', 'htmlSink', 'innerHTML'),
    invalid('document.body.insertAdjacentHTML(value);', 'htmlSink', 'insertAdjacentHTML'),
    invalid(
      'const element = <div dangerouslySetInnerHTML={{ __html: value }} />;',
      'htmlSink',
      'dangerouslySetInnerHTML',
    ),
    ...roots.map((root) => invalid(`${root}[key];`, 'dynamicGlobal')),
    invalid('globalThis[`fetch`]();', 'dynamicGlobal'),
  ],
});

tester.run('no-eval', rule('no-eval'), {
  valid: [
    {
      code: 'function run(eval) { eval(value); }',
      languageOptions: { sourceType: 'script' },
    },
    'function run(Function) { return new Function(value); }',
    'function run(setTimeout) { setTimeout("private", 1); }',
    'const window = {}; window.eval(value);',
    'setTimeout(() => work(), 1); setInterval(callback, 1); setImmediate(callback);',
    'import("allowed");',
    'const obj = {}; obj.eval(value); obj.Function(value);',
  ],
  invalid: [
    invalid('eval("private");', 'codeExecution', 'eval'),
    invalid('(0, eval)(value);', 'codeExecution', 'eval'),
    invalid('eval?.(value);', 'codeExecution', 'eval'),
    invalid('eval.call(null, value);', 'codeExecution', 'eval'),
    invalid('new Function("private");', 'codeExecution', 'Function'),
    invalid('Function(value);', 'codeExecution', 'Function'),
    ...roots.flatMap((root) => [
      invalid(`${root}['eval'](value);`, 'codeExecution', 'eval'),
      invalid(`new ${root}.Function(value);`, 'codeExecution', 'Function'),
    ]),
    ...['setTimeout', 'setInterval', 'setImmediate'].flatMap((name) => [
      invalid(`${name}("private", 1);`, 'codeExecution', name),
      invalid(`${name}(\`private \${value}\`, 1);`, 'codeExecution', name),
      invalid(`globalThis['${name}'](\`private\`, 1);`, 'codeExecution', name),
    ]),
    invalid('import(source);', 'dynamicImport'),
    invalid('import(`allowed`);', 'dynamicImport'),
    invalid('import("prefix/" + value);', 'dynamicImport'),
  ],
});

const modelSources = [
  '@langchain/openai',
  '@langchain/anthropic',
  '@langchain/google-genai',
  '@langchain/ollama',
  '@langchain/mistralai',
  '@langchain/groq',
  '@langchain/community',
  '@mlc-ai/web-llm',
  '@google/genai',
  'openai',
  '@anthropic-ai/sdk',
  '@galaxie/models',
];
const adkModels = ['Gemini', 'ApigeeLlm', 'ChromeBuiltInLlm', 'LLMRegistry', 'RoutedLlm'];
tester.run('no-direct-model', rule('no-direct-model'), {
  valid: [
    'import { x } from "@langchain/core/messages";',
    'import { x } from "@galaxie/core";',
    'import "openai-other"; import "@galaxie/models-other";',
    'const LanguageModel = {}; LanguageModel.create();',
    'import { LanguageModel } from "allowed"; LanguageModel.create();',
    'function run(globalThis) { globalThis.LanguageModel.create(); }',
    'const obj = {}; obj.LanguageModel.create();',
    'import { LlmAgent, FunctionTool } from "@google/adk"; new LlmAgent({ model: host.adk.llm("agent") });',
    'import * as adk from "@google/adk"; new adk.LlmAgent({});',
    'import { Gemini } from "other"; new Gemini();',
    'const Gemini = class {}; new Gemini();',
    'import * as adk from "other"; new adk.Gemini();',
    'import * as adk from "@google/adk"; const adk2 = {}; adk2.Gemini; adk["dynamic" + 1];',
    { code: 'import "openai/subpath";', options: [{ allow: ['openai'] }] },
    { code: 'import "openai/allowed";', options: [{ allow: ['openai/allowed'] }] },
    { code: 'import "vendor/model";', options: [{ extraSources: ['vendor/model-other'] }] },
    {
      code: 'import "vendor/model";',
      options: [{ extraSources: ['vendor'], allow: ['vendor/model'] }],
    },
  ],
  invalid: [
    ...modelSources.flatMap((source) => [
      invalid(`import { Model } from '${source}';`, 'directModel', source),
      invalid(`import '${source}/subpath';`, 'directModel', source),
      invalid(`export { Model } from '${source}';`, 'directModel', source),
      invalid(`export * from '${source}/subpath';`, 'directModel', source),
      invalid(`import('${source}');`, 'directModel', source),
    ]),
    ...adkModels.flatMap((name) => [
      invalid(`import { ${name} } from '@google/adk'; new ${name}();`, 'directAdkModel', name),
      invalid(`import { ${name} as Alias } from '@google/adk';`, 'directAdkModel', name),
      invalid(`import { "${name}" as Alias } from '@google/adk';`, 'directAdkModel', name),
      invalid(`export { ${name} } from '@google/adk';`, 'directAdkModel', name),
      invalid(`import * as adk from '@google/adk'; new adk.${name}();`, 'directAdkModel', name),
      invalid(`import * as adk from '@google/adk'; adk['${name}'];`, 'directAdkModel', name),
      invalid(`import { ${name} } from '@google/adk/sub';`, 'directAdkModel', name),
    ]),
    invalid('LanguageModel.create();', 'directModel', 'LanguageModel'),
    invalid('const model = LanguageModel;', 'directModel', 'LanguageModel'),
    ...roots.map((root) =>
      invalid(`${root}['LanguageModel'].create();`, 'directModel', 'LanguageModel'),
    ),
    {
      ...invalid('import "openai/other";', 'directModel', 'openai'),
      options: [{ allow: ['openai/allowed'] }],
    },
    {
      ...invalid('import "vendor/model/subpath";', 'directModel', 'vendor/model'),
      options: [{ extraSources: ['vendor/model'] }],
    },
  ],
});

it('validates model source prefix options', () => {
  const linter = new Linter();
  for (const prefix of ['', 'openai/', 'openai*', '@vendor', './model', 'vendor model']) {
    expect(() =>
      linter.verify('', [
        {
          ...galaxie.configs.recommended,
          rules: { 'galaxie/no-direct-model': ['error', { extraSources: [prefix] }] },
        },
      ]),
    ).toThrow();
  }
  expect(() =>
    linter.verify('', [
      {
        ...galaxie.configs.recommended,
        rules: { 'galaxie/no-direct-model': ['error', { unknown: true }] },
      },
    ]),
  ).toThrow();
});

it('keeps reports content-free and de-duplicates overlapping platform access', () => {
  const linter = new Linter();
  const messages = linter.verify(
    `
    window.fetch("PRIVATE_CONTENT");
    window.localStorage.setItem("PRIVATE_CONTENT", "PRIVATE_CONTENT");
    document.cookie = "PRIVATE_CONTENT";
    navigator.sendBeacon("PRIVATE_CONTENT");
    navigator.storage.persist();
    document.write("PRIVATE_CONTENT");
  `,
    galaxie.configs.recommended,
  );
  expect(messages.map(({ ruleId, messageId }) => [ruleId, messageId])).toEqual([
    ['galaxie/no-direct-network', 'directNetwork'],
    ['galaxie/no-direct-storage', 'directStorage'],
    ['galaxie/no-direct-storage', 'directStorage'],
    ['galaxie/no-direct-network', 'directNetwork'],
    ['galaxie/no-direct-storage', 'directStorage'],
    ['galaxie/no-dom', 'htmlSink'],
  ]);
  expect(JSON.stringify(messages)).not.toContain('PRIVATE_CONTENT');
});

it('distinguishes literal property keys from nested platform paths and dynamic keys', () => {
  const messages = new Linter().verify(
    `
    globalThis['navigator.sendBeacon'];
    globalThis['document.cookie'];
    globalThis['navigator.storage'];
    globalThis[true];
    globalThis[null];
    globalThis[1n];
    globalThis[/fetch/];
  `,
    galaxie.configs.recommended,
  );
  expect(messages).toEqual([]);
});

tester.run('no-dom assignment targets and optional calls', rule('no-dom'), {
  valid: [
    '({ value: element.textContent } = input);',
    '[element.textContent] = input;',
    '({ [element.innerHTML]: value } = input);',
    '({ value = element.innerHTML } = input);',
  ],
  invalid: [
    invalid('(element?.insertAdjacentHTML)("beforeend", value);', 'htmlSink', 'insertAdjacentHTML'),
    invalid('(element?.createContextualFragment)(value);', 'htmlSink', 'createContextualFragment'),
    invalid('(document?.write)(value);', 'htmlSink', 'write'),
    invalid('(globalThis.document?.writeln)(value);', 'htmlSink', 'writeln'),
    invalid('({ value: element.innerHTML } = input);', 'htmlSink', 'innerHTML'),
    invalid('[element.srcdoc] = input;', 'htmlSink', 'srcdoc'),
    invalid('({ value: element.outerHTML = "" } = input);', 'htmlSink', 'outerHTML'),
    invalid('({ value: [element.outerHTML] } = input);', 'htmlSink', 'outerHTML'),
    invalid('[...element.innerHTML] = input;', 'htmlSink', 'innerHTML'),
    invalid('({...element.innerHTML} = input);', 'htmlSink', 'innerHTML'),
    invalid('({ value: document.body.innerHTML } = input);', 'htmlSink', 'innerHTML'),
  ],
});
