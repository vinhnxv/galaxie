// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from '@typescript/typescript6';

interface ImportReference {
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly hasTypes: boolean;
  readonly dynamic: boolean;
}

const problems: string[] = [];

function files(directory: string, extension: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
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

for (const file of files('packages/core/src', '.ts')) {
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

for (const file of files('packages/adapter-langgraph/src', '.ts')) {
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
    JSON.stringify(['@langchain/core', '@mlc-ai/web-llm']) ||
  models.peerDependencies?.['@mlc-ai/web-llm'] !== '0.2.86' ||
  models.peerDependenciesMeta?.['@mlc-ai/web-llm']?.optional !== true
)
  problems.push(
    'packages/models/package.json: models peers must be @langchain/core and optional @mlc-ai/web-llm 0.2.86',
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

for (const file of files('packages/models/src', '.ts')) {
  for (const { specifier, hasTypes, dynamic } of imports(file)) {
    if (
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      specifier.startsWith('@langchain/core/') ||
      (specifier === '@mlc-ai/web-llm' &&
        !hasTypes &&
        ((file === 'packages/models/src/webllm/engine.ts' && dynamic) ||
          (file === 'packages/models/src/webllm/worker.ts' && !dynamic)))
    )
      continue;
    problems.push(`${file}: forbidden models import ${specifier}`);
  }
}

for (const directory of [
  'packages/core/dist',
  'packages/adapter-langgraph/dist',
  'packages/models/dist',
]) {
  for (const file of files(directory, '.js')) {
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
