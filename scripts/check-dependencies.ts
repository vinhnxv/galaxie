// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from '@typescript/typescript6';

interface ImportReference {
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly hasTypes: boolean;
  readonly dynamic: boolean;
}

const problems: string[] = [];

function files(directory: string, extension: RegExp): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extension.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

function imports(file: string): ImportReference[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const references: ImportReference[] = [];
  const add = (node: ts.Node, typeOnly: boolean, hasTypes = typeOnly, dynamic = false): void => {
    if (ts.isStringLiteralLike(node))
      references.push({ specifier: node.text, typeOnly, hasTypes, dynamic });
    else problems.push(`${file}: import specifiers must be string literals`);
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
      );
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      add(node.argument.literal, true);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument === undefined) problems.push(`${file}: dynamic imports require a specifier`);
      else add(argument, false, false, true);
    } else if (
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require') ||
      (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
    ) {
      // Packages are ES modules; a CommonJS load would bypass the specifier rules above.
      problems.push(`${file}: CommonJS loads are not allowed`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

const core = JSON.parse(readFileSync('packages/core/package.json', 'utf8')) as {
  dependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: Record<string, unknown>;
};
if (core.dependencies !== undefined)
  problems.push('packages/core/package.json: core must not declare dependencies');
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
  for (const reference of imports(file)) {
    const { specifier, typeOnly } = reference;
    if (
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier === '@opentelemetry/api' ||
      (specifier === 'zod/v4/core' && typeOnly)
    )
      continue;
    problems.push(`${file}: forbidden core import ${specifier}`);
  }
}

for (const file of files('packages/adapter-langgraph/src', /\.[cm]?tsx?$/)) {
  for (const { specifier } of imports(file)) {
    if (specifier.startsWith('@langchain/langgraph') && specifier !== '@langchain/langgraph/web')
      problems.push(
        `${file}: LangGraph imports must use @langchain/langgraph/web, received ${specifier}`,
      );
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
    JSON.stringify(['@langchain/core', '@langchain/openai', '@mlc-ai/web-llm']) ||
  models.peerDependencies?.['@langchain/openai'] !== '1.6.3' ||
  models.peerDependenciesMeta?.['@langchain/openai']?.optional !== true ||
  models.peerDependencies?.['@mlc-ai/web-llm'] !== '0.2.86' ||
  models.peerDependenciesMeta?.['@mlc-ai/web-llm']?.optional !== true
)
  problems.push(
    'packages/models/package.json: models peers must be @langchain/core, optional @langchain/openai 1.6.3 and optional @mlc-ai/web-llm 0.2.86',
  );
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

for (const directory of [
  'packages/core/dist',
  'packages/adapter-langgraph/dist',
  'packages/models/dist',
  'packages/react/dist',
  'packages/storage-indexeddb/dist',
  'packages/tools-mcp/dist',
]) {
  for (const file of files(directory, /\.[cm]?js$/)) {
    if (readFileSync(file, 'utf8').includes('async_hooks'))
      problems.push(`${file}: built packages must not contain async_hooks`);
    for (const { specifier } of imports(file)) {
      if (specifier.startsWith('node:'))
        problems.push(`${file}: built packages must not import ${specifier}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
