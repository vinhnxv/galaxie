// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from '@typescript/typescript6';

interface ImportReference {
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly hasTypes: boolean;
  readonly dynamic: boolean;
  /** Type stripping erases the whole declaration, so the module is never evaluated. */
  readonly erased: boolean;
}

const problems: string[] = [];

function files(directory: string, extension: RegExp): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extension.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function imports(file: string, strict = true): ImportReference[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const references: ImportReference[] = [];
  const add = (
    node: ts.Node,
    typeOnly: boolean,
    hasTypes = typeOnly,
    dynamic = false,
    erased = false,
  ): void => {
    if (ts.isStringLiteralLike(node))
      references.push({ specifier: node.text, typeOnly, hasTypes, dynamic, erased });
    else if (strict) problems.push(`${file}: import specifiers must be string literals`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause?.name === undefined &&
          named !== undefined &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((element) => element.isTypeOnly));
      add(
        node.moduleSpecifier,
        typeOnly,
        typeOnly ||
          (named !== undefined &&
            ts.isNamedImports(named) &&
            named.elements.some((element) => element.isTypeOnly)),
        false,
        clause?.isTypeOnly === true,
      );
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const typeOnly =
        node.isTypeOnly ||
        (node.exportClause !== undefined &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.length > 0 &&
          node.exportClause.elements.every((element) => element.isTypeOnly));
      add(
        node.moduleSpecifier,
        typeOnly,
        typeOnly ||
          (node.exportClause !== undefined &&
            ts.isNamedExports(node.exportClause) &&
            node.exportClause.elements.some((element) => element.isTypeOnly)),
        false,
        node.isTypeOnly,
      );
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true, true, false, true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument === undefined) {
        if (strict) problems.push(`${file}: dynamic imports require a specifier`);
      } else add(argument, false, false, true);
    } else if (
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require') ||
      (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
    ) {
      // Packages are ES modules; a CommonJS load would bypass the specifier rules above.
      if (strict) problems.push(`${file}: CommonJS loads are not allowed`);
      else if (ts.isCallExpression(node)) {
        const argument = node.arguments[0];
        if (argument !== undefined) add(argument, false);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const expression = node.moduleReference.expression;
        if (expression !== undefined) add(expression, false);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

const browserModules = new Set(
  ['browser', 'ownership', 'invalidation'].map((name) => resolve(`packages/core/src/${name}.js`)),
);
const browserGlobals = new Set(['navigator', 'document', 'window', 'BroadcastChannel']);

/**
 * A guarded reference is inside a function body and either follows a same-function
 * `typeof <global> ===/!== 'undefined'` check or reads a globalThis property without
 * dereferencing/calling a missing value (optional chaining permits that next step).
 * This is a lexical check, not control-flow analysis; nested functions start fresh.
 * Type positions and declaration/property names are not runtime references.
 */
function checkCoreGlobals(file: string): void {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const globalName = (node: ts.Node): string | undefined => {
    if (ts.isIdentifier(node) && browserGlobals.has(node.text)) return node.text;
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      browserGlobals.has(node.name.text)
    )
      return node.name.text;
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'globalThis' &&
      ts.isStringLiteral(node.argumentExpression) &&
      browserGlobals.has(node.argumentExpression.text)
    )
      return node.argumentExpression.text;
    return undefined;
  };
  const visit = (node: ts.Node, guards?: Set<string>): void => {
    if (
      ts.isTypeNode(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node)
    )
      return;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      ts.forEachChild(node, (child) => visit(child, child === node.body ? new Set() : guards));
      return;
    }
    const parent = node.parent;
    const name = globalName(node);
    const namedDeclaration =
      ts.isIdentifier(node) &&
      'name' in parent &&
      parent.name === node &&
      !ts.isShorthandPropertyAssignment(parent);
    if (name !== undefined && !namedDeclaration) {
      let reference = node;
      while (ts.isParenthesizedExpression(reference.parent)) reference = reference.parent;
      const use = reference.parent;
      const dereferenced =
        ((ts.isPropertyAccessExpression(use) ||
          ts.isElementAccessExpression(use) ||
          ts.isCallExpression(use)) &&
          use.expression === reference &&
          use.questionDotToken === undefined) ||
        (ts.isNewExpression(use) && use.expression === reference);
      if (
        guards === undefined ||
        (!guards.has(name) &&
          !ts.isTypeOfExpression(use) &&
          (ts.isIdentifier(node) || dereferenced))
      )
        problems.push(`${file}: browser global ${name} must be guarded inside a function`);
    }
    ts.forEachChild(node, (child) => visit(child, guards));
    if (
      guards !== undefined &&
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      for (const [check, value] of [
        [node.left, node.right],
        [node.right, node.left],
      ] as const) {
        if (
          ts.isTypeOfExpression(check) &&
          ts.isStringLiteral(value) &&
          value.text === 'undefined'
        ) {
          const checked = globalName(check.expression);
          if (checked !== undefined) guards.add(checked);
        }
      }
    }
  };
  visit(source);
}

const core = JSON.parse(readFileSync('packages/core/package.json', 'utf8')) as {
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: Record<string, unknown>;
};
if (
  core.dependencies === null ||
  typeof core.dependencies !== 'object' ||
  Array.isArray(core.dependencies) ||
  JSON.stringify(Object.keys(core.dependencies).sort()) !== JSON.stringify(['@galaxie/ui-protocol'])
)
  problems.push(
    'packages/core/package.json: core dependencies must be exactly @galaxie/ui-protocol',
  );
if (core.optionalDependencies !== undefined)
  problems.push('packages/core/package.json: core must not declare optionalDependencies');
if (
  JSON.stringify(Object.keys(core.peerDependencies ?? {}).sort()) !==
  JSON.stringify(['@opentelemetry/api', 'zod'])
)
  problems.push(
    'packages/core/package.json: core peers must be exactly @opentelemetry/api and zod',
  );

for (const file of files('packages/core/src', /\.[cm]?tsx?$/)) {
  const mainEntry = !browserModules.has(resolve(file).replace(/\.ts$/, '.js'));
  if (mainEntry) checkCoreGlobals(file);
  for (const reference of imports(file)) {
    const { specifier, typeOnly } = reference;
    if (mainEntry && browserModules.has(resolve(dirname(file), specifier).replace(/\.ts$/, '.js')))
      problems.push(`${file}: main-entry modules must not import or re-export ${specifier}`);
    if (
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier === '@opentelemetry/api' ||
      specifier === '@galaxie/ui-protocol' ||
      (specifier === 'zod/v4/core' && typeOnly)
    )
      continue;
    problems.push(`${file}: forbidden core import ${specifier}`);
  }
}

/** The kit is not an executor, and adapters reach it only through its public root. */
function kitImport(file: string, specifier: string): boolean {
  if (specifier === '@galaxie/adapter-kit') return true;
  if (specifier.startsWith('@galaxie/adapter-kit/')) {
    problems.push(`${file}: adapter-kit imports must use the public root @galaxie/adapter-kit`);
    return true;
  }
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const target = resolve(dirname(file), specifier);
    if (
      target === resolve('packages/adapter-kit') ||
      target.startsWith(`${resolve('packages/adapter-kit')}/`)
    ) {
      problems.push(`${file}: adapter-kit imports must use the public root @galaxie/adapter-kit`);
      return true;
    }
  }
  return false;
}

function relativeAdapterImport(file: string, specifier: string, ownPackage: string): boolean {
  const target = resolve(dirname(file), specifier);
  const [package_] = relative(resolve('packages'), target).split(/[\\/]/);
  if (
    target.split(/[\\/]/).includes('node_modules') ||
    (package_?.startsWith('adapter-') === true && package_ !== ownPackage)
  ) {
    problems.push(
      `${file}: relative import ${specifier} reaches into a dependency or another adapter`,
    );
    return true;
  }
  return false;
}

for (const area of ['src', 'dist', 'test']) {
  const directory = join('packages/adapter-langgraph', area);
  if (!existsSync(directory)) continue;
  for (const file of files(directory, /\.[cm]?[jt]sx?$/)) {
    for (const { specifier } of imports(file)) {
      if (kitImport(file, specifier)) continue;
      if (specifier.startsWith('@galaxie/adapter-')) {
        problems.push(`${file}: the LangGraph adapter must not depend on another executor adapter`);
        continue;
      }
      if (specifier.startsWith('@langchain/langgraph') && specifier !== '@langchain/langgraph/web')
        problems.push(
          `${file}: LangGraph imports must use @langchain/langgraph/web, received ${specifier}`,
        );
      if (specifier.startsWith('./') || specifier.startsWith('../'))
        relativeAdapterImport(file, specifier, 'adapter-langgraph');
    }
  }
}

for (const area of ['src', 'dist', 'test']) {
  const directory = join('packages/adapter-kit', area);
  if (!existsSync(directory)) continue;
  for (const file of files(directory, /\.[cm]?[jt]sx?$/)) {
    for (const { specifier, erased } of imports(file)) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const target = resolve(dirname(file), specifier);
        if (
          !target.split(/[\\/]/).includes('node_modules') &&
          (target.startsWith(`${resolve('packages/adapter-kit')}/`) ||
            (area === 'test' && target.startsWith(`${resolve('tests/conformance/support')}/`)))
        )
          continue;
      } else if (specifier === '@galaxie/core') {
        continue;
      } else if (specifier === '@langchain/core' || specifier.startsWith('@langchain/core/')) {
        if (area === 'test' || (erased && (area !== 'dist' || /\.d\.[cm]?ts$/.test(file))))
          continue;
      } else if (area === 'test' && (specifier === 'vitest' || specifier.startsWith('node:'))) {
        continue;
      }
      problems.push(`${file}: forbidden adapter-kit import ${specifier}`);
    }
  }
}

// Protocol validation is independent of every framework, host and platform service.
for (const area of ['src', 'dist', 'test']) {
  const directory = join('packages/ui-protocol', area);
  if (!existsSync(directory)) continue;
  for (const file of files(directory, /\.[cm]?[jt]sx?$/)) {
    for (const { specifier } of imports(file)) {
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const target = resolve(dirname(file), specifier);
        if (
          target.startsWith(`${resolve('packages/ui-protocol')}/`) &&
          !target.split(/[\\/]/).includes('node_modules')
        )
          continue;
      } else if (
        area === 'test' &&
        (specifier === 'vitest' ||
          (file.endsWith('.node.test.ts') &&
            ['node:fs', 'node:path', 'node:url'].includes(specifier)))
      )
        continue;
      problems.push(`${file}: forbidden ui-protocol import ${specifier}`);
    }
    if (area === 'test') continue;
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const forbidden = new Set([
      'document',
      'window',
      'Worker',
      'SharedWorker',
      'navigator',
      'BroadcastChannel',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'fetch',
      'XMLHttpRequest',
      'WebSocket',
      'setTimeout',
      'setInterval',
      'requestAnimationFrame',
      'process',
      'Buffer',
    ]);
    const visit = (node: ts.Node): void => {
      if (
        (ts.isIdentifier(node) && forbidden.has(node.text)) ||
        (ts.isElementAccessExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'globalThis' &&
          ts.isStringLiteral(node.argumentExpression) &&
          forbidden.has(node.argumentExpression.text))
      ) {
        problems.push(`${file}: ui-protocol must not use platform globals`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

for (const area of ['src', 'dist', 'test']) {
  const directory = join('packages/adapter-pyodide', area);
  if (!existsSync(directory)) continue;
  for (const file of files(directory, /\.[cm]?[jt]sx?$/)) {
    for (const { specifier } of imports(file)) {
      if (kitImport(file, specifier)) continue;
      if (specifier.startsWith('@langchain/langgraph') || specifier.startsWith('@galaxie/adapter-'))
        problems.push(`${file}: the Python adapter must not depend on another executor`);
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        relativeAdapterImport(file, specifier, 'adapter-pyodide');
        continue;
      }
      const worker = file === `${directory}/worker.${area === 'dist' ? 'js' : 'ts'}`;
      if (
        specifier === '@galaxie/core' ||
        specifier.startsWith('@langchain/core/') ||
        (worker && ['pyodide', 'node:worker_threads', 'node:fs', 'node:os'].includes(specifier)) ||
        (area === 'test' &&
          (specifier.startsWith('node:') ||
            ['vitest', 'zod', '@galaxie/models/mock'].includes(specifier)))
      )
        continue;
      problems.push(`${file}: forbidden Python adapter import ${specifier}`);
    }
  }
}

for (const area of ['src', 'dist', 'test']) {
  const directory = join('packages/adapter-go', area);
  if (!existsSync(directory)) continue;
  for (const file of files(directory, /\.[cm]?[jt]sx?$/)) {
    for (const { specifier } of imports(file)) {
      if (kitImport(file, specifier)) continue;
      if (
        specifier.startsWith('@langchain/langgraph') ||
        specifier.startsWith('@galaxie/adapter-') ||
        specifier === 'pyodide' ||
        specifier === '@google/adk' ||
        specifier.startsWith('@google/adk/')
      )
        problems.push(`${file}: the Go adapter must not depend on another executor or framework`);
      else if (specifier.startsWith('./') || specifier.startsWith('../')) {
        relativeAdapterImport(file, specifier, 'adapter-go');
      } else if (
        specifier === '@galaxie/core' ||
        specifier.startsWith('@langchain/core/') ||
        (area === 'test' &&
          (specifier.startsWith('node:') ||
            ['vitest', 'zod', '@galaxie/models/mock'].includes(specifier)))
      )
        continue;
      else problems.push(`${file}: forbidden Go adapter import ${specifier}`);
    }
  }
}

/**
 * Whether Go source imports `syscall/js` in any import form: single or grouped, aliased or blank,
 * interpreted or raw string, on one line or several. Comments are removed first, strings kept.
 */
function importsSyscallJs(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) =>
    match.startsWith('/*') ? ' ' : '',
  );
  const declarations = code.matchAll(/(?:^|[^\w.])import\s*(?:\(([^)]*)\)|([^\n(]*))/g);
  return [...declarations].some((match) =>
    /(?:^|[\s;(])(?:[\w.]+\s+)?(?:"syscall\/js"|`syscall\/js`)/.test(match[1] ?? match[2] ?? ''),
  );
}

// Only the bridge package and the first-run gate may call into JavaScript.
const SYSCALL_JS_DIRECTORIES = ['go/galaxie/bridge', 'go/gate'];
if (existsSync('go')) {
  for (const entry of readdirSync('go', { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.go')) continue;
    const file = join(entry.parentPath, entry.name);
    if (!importsSyscallJs(readFileSync(file, 'utf8'))) continue;
    if (!SYSCALL_JS_DIRECTORIES.some((allowed) => dirname(file) === allowed))
      problems.push(`${file}: syscall/js belongs only in go/galaxie/bridge and go/gate`);
  }
}

const ADK_TEST_ONLY = new Set([
  'vitest',
  'vite',
  'playwright',
  'zod',
  'es-module-lexer',
  '@opentelemetry/api',
  '@opentelemetry/sdk-trace',
]);
for (const area of ['src', 'dist', 'test']) {
  const directory = join('packages/adapter-adk', area);
  if (!existsSync(directory)) continue;
  for (const file of files(directory, /\.[cm]?[jt]sx?$/)) {
    for (const { specifier, erased } of imports(file)) {
      if (kitImport(file, specifier)) continue;
      if (specifier.startsWith('@google/adk/')) {
        problems.push(
          `${file}: ADK subpath imports are not allowed (Node-only or networked code), received ${specifier}`,
        );
        continue;
      }
      if (specifier === '@google/genai' || specifier.startsWith('@google/genai/')) {
        if (!erased)
          problems.push(
            `${file}: @google/genai may be imported as a type only, with a declaration-level \`import type\` (the bundle inlines its own copy)`,
          );
        continue;
      }
      if (specifier.startsWith('@langchain/langgraph') || specifier.startsWith('@galaxie/adapter-'))
        problems.push(`${file}: the ADK adapter must not depend on another executor adapter`);
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        relativeAdapterImport(file, specifier, 'adapter-adk');
        continue;
      }
      if (
        specifier === '@google/adk' ||
        specifier === '@galaxie/core' ||
        specifier.startsWith('@langchain/core/') ||
        ((area !== 'dist' || file.endsWith('.d.ts')) && specifier === 'zod') ||
        (area === 'test' &&
          (specifier.startsWith('node:') ||
            ADK_TEST_ONLY.has(specifier) ||
            specifier === '@galaxie/models/mock'))
      )
        continue;
      problems.push(`${file}: forbidden ADK adapter import ${specifier}`);
    }
  }
}

const EXEMPT_FROM_ADK_SCAN = new Set([
  'scripts/check-dependencies.ts',
  // The lint rule names the ADK model classes it flags; it imports nothing from ADK.
  'packages/eslint-plugin/src/rules/no-direct-model.ts',
  'packages/eslint-plugin/dist/rules/no-direct-model.js',
  'packages/eslint-plugin/test/rules.test.ts',
  'tests/conformance/check-dependencies.node.test.ts',
]);
const isNativeReferenceRun = (file: string, specifier: string | undefined): boolean =>
  specifier === '@google/adk' && file.startsWith('tests/conformance/');

function sourceFilesOutsideDependencies(directory: string, includeDist: boolean): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || (entry.name === 'dist' && !includeDist)) return [];
      return sourceFilesOutsideDependencies(path, includeDist);
    }
    return entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

for (const root of ['examples', 'templates', 'tests', 'scripts', 'packages']) {
  for (const file of sourceFilesOutsideDependencies(root, root === 'packages')) {
    if (EXEMPT_FROM_ADK_SCAN.has(file) || file.startsWith('packages/adapter-adk/')) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(
      /['"`](@google\/adk(?:\/[^'"`]*)?)['"`]/g,
    )) {
      if (isNativeReferenceRun(file, match[1])) continue;
      if (match[1] === '@google/adk' && file.startsWith('examples/adk-recipes/src/recipes/'))
        continue;
      problems.push(`${file}: ADK imports belong only in packages/adapter-adk (${match[1]})`);
    }
  }
}

const models = JSON.parse(readFileSync('packages/models/package.json', 'utf8')) as {
  peerDependencies?: Record<string, unknown>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
};
if (
  JSON.stringify(Object.keys(models.peerDependencies ?? {}).sort()) !==
    JSON.stringify([
      '@huggingface/transformers',
      '@huggingface/transformers-structured-output',
      '@langchain/core',
      '@langchain/openai',
      '@mlc-ai/web-llm',
    ]) ||
  models.peerDependencies?.['@huggingface/transformers'] !== '4.3.2' ||
  models.peerDependenciesMeta?.['@huggingface/transformers']?.optional !== true ||
  models.peerDependencies?.['@huggingface/transformers-structured-output'] !== '4.3.2' ||
  models.peerDependenciesMeta?.['@huggingface/transformers-structured-output']?.optional !== true ||
  models.peerDependencies?.['@langchain/openai'] !== '1.6.3' ||
  models.peerDependenciesMeta?.['@langchain/openai']?.optional !== true ||
  models.peerDependencies?.['@mlc-ai/web-llm'] !== '0.2.86' ||
  models.peerDependenciesMeta?.['@mlc-ai/web-llm']?.optional !== true
)
  problems.push(
    'packages/models/package.json: models peers must be @langchain/core, optional @huggingface/transformers 4.3.2, optional @huggingface/transformers-structured-output 4.3.2, optional @langchain/openai 1.6.3 and optional @mlc-ai/web-llm 0.2.86',
  );
// The hand-pinned ONNX Runtime must be the one the pinned Transformers.js declares, or the Worker
// would load a runtime the library was not built against.
{
  const transformersVersion = models.peerDependencies?.['@huggingface/transformers'];
  const declared = readFileSync('pnpm-lock.yaml', 'utf8').match(
    new RegExp(
      `^  '@huggingface/transformers@${String(transformersVersion).replaceAll('.', '\\.')}\\([^\\n]*\\)':\\n(?:    [^\\n]*\\n)*?      onnxruntime-web: (\\S+)`,
      'm',
    ),
  )?.[1];
  const pinned = (models.devDependencies as Record<string, unknown> | undefined)?.[
    'onnxruntime-web'
  ];
  if (declared === undefined || declared !== pinned)
    problems.push(
      `packages/models/package.json: onnxruntime-web must equal ${declared ?? 'the version @huggingface/transformers declares in pnpm-lock.yaml'}, found ${String(pinned)}`,
    );
}
for (const field of [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const) {
  if (Object.hasOwn(models[field] ?? {}, '@galaxie/core'))
    problems.push('packages/models/package.json: models must not depend on @galaxie/core');
}

for (const file of files('packages/models/src', /\.[cm]?tsx?$/)) {
  for (const { specifier, hasTypes, dynamic } of imports(file)) {
    if (
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier.startsWith('@langchain/core/') ||
      (specifier === '@langchain/openai' && file.startsWith('packages/models/src/openai/')) ||
      ((specifier === '@huggingface/transformers' ||
        specifier === '@huggingface/transformers-structured-output') &&
        !hasTypes &&
        dynamic &&
        file === 'packages/models/src/transformers/runtime.ts') ||
      (specifier === '@mlc-ai/web-llm' &&
        !hasTypes &&
        (((file === 'packages/models/src/webllm/engine.ts' ||
          file === 'packages/models/src/webllm/cache.ts') &&
          dynamic) ||
          (file === 'packages/models/src/webllm/worker.ts' && !dynamic)))
    )
      continue;
    problems.push(`${file}: forbidden models import ${specifier}`);
  }
}

for (const file of files('packages/storage-indexeddb/src', /\.[cm]?tsx?$/)) {
  for (const { specifier, typeOnly } of imports(file)) {
    if (
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier === '@langchain/langgraph-checkpoint' ||
      (specifier.startsWith('@langchain/core/') && typeOnly)
    )
      continue;
    problems.push(`${file}: forbidden IndexedDB storage import ${specifier}`);
  }
}

for (const area of ['src', 'dist']) {
  const directory = join('packages/tools-mcp', area);
  if (!existsSync(directory)) continue;
  for (const file of files(directory, /\.[cm]?[jt]sx?$/)) {
    for (const { specifier } of imports(file)) {
      if (
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier === '@galaxie/core' ||
        specifier.startsWith('@modelcontextprotocol/sdk/client/') ||
        specifier === '@modelcontextprotocol/sdk/types.js'
      )
        continue;
      problems.push(`${file}: forbidden MCP client import ${specifier}`);
    }
  }
}

for (const file of files('packages/eslint-plugin/src', /\.[cm]?tsx?$/)) {
  for (const { specifier, typeOnly } of imports(file)) {
    if (
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      (specifier === 'eslint' && typeOnly)
    )
      continue;
    problems.push(`${file}: ESLint plugin imports must be relative or type-only from eslint`);
  }
}

for (const entry of readdirSync('packages', { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  for (const area of ['src', 'dist', ...(entry.name === 'react' ? ['test'] : [])]) {
    const directory = join('packages', entry.name, area);
    if (!existsSync(directory)) continue;
    for (const file of files(directory, /\.[cm]?[jt]sx?$/)) {
      for (const { specifier } of imports(file)) {
        if (
          (specifier === '@langchain/openai' || specifier.startsWith('@langchain/openai/')) &&
          !(
            entry.name === 'models' &&
            (area === 'src' || area === 'dist') &&
            file.startsWith(`${directory}/openai/`)
          )
        )
          problems.push(`${file}: OpenAI imports belong only in the models openai provider`);
        if (
          area !== 'test' &&
          (specifier.startsWith('@galaxie/example-') ||
            resolve(dirname(file), specifier).startsWith(`${resolve('examples')}/`))
        )
          problems.push(`${file}: packages must not import examples`);
        const react = specifier === 'react' || specifier.startsWith('react/');
        const reactDom = specifier === 'react-dom' || specifier.startsWith('react-dom/');
        if (entry.name !== 'react') {
          if (react || reactDom)
            problems.push(`${file}: React imports belong only in packages/react`);
          continue;
        }
        if (
          specifier.startsWith('./') ||
          specifier.startsWith('../') ||
          specifier === '@galaxie/core' ||
          specifier === '@galaxie/ui-protocol' ||
          react ||
          specifier === 'zod' ||
          (area === 'test' && (reactDom || specifier === 'vitest'))
        )
          continue;
        problems.push(`${file}: forbidden React package import ${specifier}`);
      }
    }
  }
}

for (const area of ['src', 'dist']) {
  const directory = join('examples/english-tutor', area);
  if (!existsSync(directory)) continue;
  for (const file of files(directory, /\.[cm]?[jt]sx?$/)) {
    for (const { specifier } of imports(file)) {
      if (
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier === '@galaxie/core' ||
        specifier === '@galaxie/adapter-langgraph' ||
        specifier === '@langchain/langgraph/web' ||
        specifier.startsWith('@langchain/core/') ||
        specifier === 'zod'
      )
        continue;
      problems.push(`${file}: forbidden English tutor import ${specifier}`);
    }
  }
}

for (const area of ['src', 'dist']) {
  const directory = join('examples/mcp-server', area);
  if (!existsSync(directory)) continue;
  for (const file of files(directory, /\.[cm]?[jt]sx?$/)) {
    for (const { specifier } of imports(file)) {
      if (
        specifier.startsWith('./') ||
        specifier.startsWith('../') ||
        specifier.startsWith('node:') ||
        specifier.startsWith('@modelcontextprotocol/sdk/server/') ||
        specifier === '@modelcontextprotocol/sdk/types.js' ||
        specifier === 'zod'
      )
        continue;
      problems.push(`${file}: forbidden MCP reference server import ${specifier}`);
    }
  }
}

for (const file of files('examples/host-local/src', /\.[cm]?tsx?$/)) {
  for (const { specifier, typeOnly, dynamic } of imports(file)) {
    if (
      specifier === './mock-script.js' &&
      (file !== 'examples/host-local/src/main.tsx' || !dynamic)
    )
      problems.push(
        `${file}: the mock script must be dynamically imported only by the mode entry point`,
      );
    if (
      specifier.startsWith('./') ||
      specifier === '@galaxie/core' ||
      specifier === '@galaxie/core/browser' ||
      specifier === '@galaxie/tools-mcp' ||
      specifier === '@galaxie/storage-indexeddb' ||
      specifier === '@galaxie/adapter-langgraph' ||
      specifier === '@galaxie/example-english-tutor' ||
      specifier === '@galaxie/react' ||
      specifier === '@galaxie/models/webllm' ||
      specifier === '@galaxie/models/webllm/worker' ||
      specifier === '@galaxie/models/builtin-ai' ||
      specifier === '@galaxie/models/openai' ||
      (specifier === '@galaxie/models/mock' && file === 'examples/host-local/src/mock-script.ts') ||
      specifier === 'react' ||
      specifier === 'react/jsx-runtime' ||
      specifier === 'react-dom/client' ||
      specifier === 'zod' ||
      (specifier.startsWith('@langchain/core/') && typeOnly)
    )
      continue;
    problems.push(`${file}: forbidden local host import ${specifier}`);
  }
}

for (const file of files('examples/rag-browser/src', /\.[cm]?tsx?$/)) {
  for (const { specifier, dynamic } of imports(file)) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    const target = relative
      ? resolve(dirname(file), specifier.split('?')[0] ?? '').replace(/\.[jt]sx?$/, '')
      : '';
    const mockScript = resolve('examples/rag-browser/src/host/mock-script');
    if (
      specifier === '@galaxie/storage-indexeddb' &&
      file !== 'examples/rag-browser/src/host/runtime.ts'
    )
      problems.push(`${file}: only the host runtime may open review storage`);
    if (
      specifier === '@galaxie/adapter-pyodide' &&
      file !== 'examples/rag-browser/src/host/runtime.ts'
    )
      problems.push(`${file}: only the host runtime may register the Python adapter`);
    if (
      specifier === '@galaxie/adapter-pyodide/worker' &&
      file !== 'examples/rag-browser/src/host/pyodide-worker.ts'
    )
      problems.push(`${file}: only the host Python Worker entry may load Pyodide`);
    if (target === mockScript && (file !== 'examples/rag-browser/src/host/main.tsx' || !dynamic))
      problems.push(
        `${file}: the mock script must be dynamically imported only by the mode entry point`,
      );
    if (
      (specifier === '@huggingface/transformers' || specifier.startsWith('onnxruntime-web/')) &&
      !file.startsWith('examples/rag-browser/src/retrieval/')
    )
      problems.push(`${file}: embedding dependencies belong only in the retrieval Worker`);
    if (
      file.startsWith('examples/rag-browser/src/agent/') &&
      relative &&
      !target.startsWith(`${resolve('examples/rag-browser/src/agent')}/`)
    )
      problems.push(
        `${file}: the agent must use host ports instead of importing host or retrieval code`,
      );
    if (
      (relative && target.startsWith(`${resolve('examples/rag-browser')}/`)) ||
      [
        '@galaxie/core',
        '@galaxie/core/browser',
        '@galaxie/adapter-langgraph',
        '@galaxie/adapter-pyodide',
        '@galaxie/adapter-pyodide/worker',
        '@galaxie/react',
        '@galaxie/models/webllm',
        '@galaxie/models/webllm/worker',
        '@galaxie/models/builtin-ai',
        '@langchain/langgraph/web',
        '@orama/orama',
        '@huggingface/transformers',
        'react',
        'react/jsx-runtime',
        'react-dom/client',
        'zod',
        'virtual:rag-python',
        '@galaxie/storage-indexeddb',
      ].includes(specifier) ||
      specifier.startsWith('@langchain/core/') ||
      specifier.startsWith('onnxruntime-web/') ||
      (specifier === '@galaxie/models/mock' &&
        file === 'examples/rag-browser/src/host/mock-script.ts')
    )
      continue;
    problems.push(`${file}: forbidden RAG example import ${specifier}`);
  }
}

for (const area of ['src', 'server', 'test']) {
  const directory = join('examples/host-remote', area);
  for (const file of files(directory, /\.[cm]?[jt]sx?$/)) {
    for (const { specifier, typeOnly } of imports(file)) {
      const relative = specifier.startsWith('./') || specifier.startsWith('../');
      if (relative) {
        const target = resolve(dirname(file), specifier);
        const allowed = area === 'test' ? ['src', 'server', 'test'] : [area];
        if (allowed.some((part) => target.startsWith(`${resolve('examples/host-remote', part)}/`)))
          continue;
      } else if (area === 'server') {
        if (specifier.startsWith('node:') || (specifier === 'vite' && typeOnly)) continue;
      } else if (
        specifier.startsWith('@galaxie/') ||
        specifier.startsWith('@langchain/') ||
        specifier === 'react' ||
        specifier.startsWith('react/') ||
        specifier === 'react-dom' ||
        specifier.startsWith('react-dom/') ||
        specifier === 'zod' ||
        (area === 'test' &&
          (specifier.startsWith('node:') || ['vite', 'playwright', 'vitest'].includes(specifier)))
      )
        continue;
      problems.push(`${file}: forbidden remote host ${area} import ${specifier}`);
    }
  }
}

for (const directory of [
  'packages/core/dist',
  'packages/ui-protocol/dist',
  'packages/adapter-kit/dist',
  'packages/adapter-langgraph/dist',
  'packages/adapter-pyodide/dist',
  'packages/adapter-adk/dist',
  'packages/adapter-go/dist',
  'packages/models/dist',
  'packages/react/dist',
  'packages/storage-indexeddb/dist',
  'packages/tools-mcp/dist',
]) {
  for (const file of files(directory, /\.[cm]?js$/)) {
    if (readFileSync(file, 'utf8').includes('async_hooks'))
      problems.push(`${file}: built packages must not contain async_hooks`);
    for (const { specifier } of imports(file)) {
      if (
        specifier.startsWith('node:') &&
        !(
          file === 'packages/adapter-pyodide/dist/worker.js' &&
          ['node:worker_threads', 'node:fs', 'node:os'].includes(specifier)
        )
      )
        problems.push(`${file}: built packages must not import ${specifier}`);
    }
  }
}

for (const root of ['packages', 'examples', 'templates', 'tests', 'scripts']) {
  for (const file of sourceFilesOutsideDependencies(root, true)) {
    // This inventory checks one public boundary, not unrelated host/tool import syntax.
    for (const { specifier } of imports(file, false)) {
      const target = resolve(dirname(file), specifier);
      if (
        specifier.startsWith('@galaxie/ui-protocol/') ||
        (!file.startsWith('packages/ui-protocol/') &&
          (specifier.startsWith('.') || specifier.startsWith('/')) &&
          (target === resolve('packages/ui-protocol') ||
            target.startsWith(`${resolve('packages/ui-protocol')}/`)))
      ) {
        problems.push(`${file}: ui-protocol imports must use the public root @galaxie/ui-protocol`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
