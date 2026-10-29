// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManifest } from '@galaxie/core';
import { tutorDefinition } from '@galaxie/example-english-tutor';
import ts from '@typescript/typescript6';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tutorPackage = '@galaxie/example-english-tutor';
const tutorDir = resolve(root, 'examples/english-tutor');

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function nodes(node: ts.Node): ts.Node[] {
  const result = [node];
  ts.forEachChild(node, (child) => {
    result.push(...nodes(child));
  });
  return result;
}

function files(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

function digest(path: string): string {
  // Same byte hash and encoding as scripts/build-manifest.ts; no build output is written.
  return `sha256-${createHash('sha256').update(readFileSync(path)).digest('base64')}`;
}

function hostEvidence(host: string): {
  entry: string;
  integrity: { entry: string; files: Record<string, string>; lockfile: string };
  bindings: Record<string, string>;
} {
  const directory = resolve(root, 'examples', host);
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  expect(pkg.dependencies[tutorPackage]).toBe('workspace:*');

  const config = source(resolve(directory, 'vite.config.ts'));
  const alias = nodes(config).find(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) &&
      ts.isStringLiteral(node.name) &&
      node.name.text === tutorPackage,
  );
  expect(alias).toBeDefined();
  const url = nodes(alias as ts.PropertyAssignment).find(
    (node): node is ts.NewExpression =>
      ts.isNewExpression(node) && node.expression.getText(config) === 'URL',
  );
  const path = url?.arguments?.[0];
  if (path === undefined || !ts.isStringLiteral(path)) throw new Error('Missing tutor alias.');
  const entry = realpathSync(resolve(directory, path.text));
  expect(entry).toBe(resolve(tutorDir, 'src/index.ts'));

  const sources = files(resolve(directory, 'src')).filter((path) => /\.tsx?$/.test(path));
  const imports: string[] = [];
  for (const path of sources) {
    for (const node of nodes(source(path))) {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        specifier = node.moduleSpecifier;
      } else if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword
      ) {
        specifier = node.arguments[0];
      }
      if (specifier !== undefined && ts.isStringLiteral(specifier)) {
        const name = specifier.text;
        imports.push(name);
        if (name.includes('english-tutor')) expect(name).toBe(tutorPackage);
        if (name.startsWith('.')) {
          expect(resolve(dirname(path), name).startsWith(`${tutorDir}/`)).toBe(false);
        }
      }
      // Hosts bind the package; they do not build a replacement graph.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        expect(node.expression.name.text).not.toBe('addNode');
      }
      if (ts.isNewExpression(node)) expect(node.expression.getText()).not.toBe('StateGraph');
    }
  }
  expect(imports).toContain(tutorPackage);
  const runtime = source(resolve(directory, 'src/runtime.ts'));
  const definitionImports = runtime.statements
    .filter(ts.isImportDeclaration)
    .filter((node) => node.importClause?.getText(runtime).includes('tutorDefinition'));
  expect(definitionImports.map((node) => (node.moduleSpecifier as ts.StringLiteral).text)).toEqual([
    tutorPackage,
  ]);
  expect(runtime.text).toContain('runtime.create(tutorDefinition,');

  const policy = nodes(runtime).find(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && node.name.getText(runtime) === 'policy',
  );
  const destination = nodes(policy as ts.VariableDeclaration).find(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && node.name.getText(runtime) === 'destination',
  );
  if (destination === undefined || !ts.isStringLiteral(destination.initializer))
    throw new Error('Missing binding destination.');
  const destinationName = destination.initializer.text;
  const bindingDeclaration = nodes(runtime).find(
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) && node.name.getText(runtime) === 'bindings',
  );
  const bindings = nodes(bindingDeclaration as ts.VariableDeclaration)
    .filter(ts.isPropertyAssignment)
    .filter((node) => ts.isStringLiteral(node.name) && node.name.text.endsWith('@1'));
  expect(bindings).toHaveLength(2);
  for (const binding of bindings) {
    expect(binding.initializer.getText(runtime)).toContain('...policy');
    expect(ts.isCallExpression(binding.initializer)).toBe(host === 'host-remote');
    if (ts.isCallExpression(binding.initializer)) {
      expect(binding.initializer.expression.getText(runtime)).toBe('httpCapability');
    }
  }

  // Vite bundles source, whereas the release manifest inventories dist. Hash the source
  // entry and its entire source inventory, plus package metadata and declared skills.
  const { manifest } = createManifest(tutorDefinition, { entry: './src/index.ts' });
  const inventory = [
    resolve(tutorDir, 'package.json'),
    ...files(dirname(entry)),
    ...(manifest.skills ?? []).map((path) => resolve(tutorDir, path)),
  ].sort();
  return {
    entry,
    integrity: {
      entry: digest(entry),
      files: Object.fromEntries(
        inventory.map((path) => [`./${relative(tutorDir, path)}`, digest(path)]),
      ),
      lockfile: digest(resolve(root, 'pnpm-lock.yaml')),
    },
    bindings: Object.fromEntries(
      bindings.map((node) => [(node.name as ts.StringLiteral).text, destinationName]),
    ),
  };
}

test('AT-05: both hosts bundle one tutor source digest and inventory with different bindings', () => {
  const local = hostEvidence('host-local');
  const remote = hostEvidence('host-remote');
  expect(local.entry).toBe(remote.entry);
  expect(local.integrity).toEqual(remote.integrity);
  expect(local.integrity.entry).toMatch(/^sha256-[A-Za-z0-9+/]{43}=$/);
  expect(local.integrity.files['./src/index.ts']).toBe(local.integrity.entry);
  expect(Object.keys(local.integrity.files).length).toBeGreaterThan(1);
  expect(local.bindings).toEqual({
    'lessons.get@1': 'in-browser',
    'progress.save@1': 'in-browser',
  });
  expect(remote.bindings).toEqual({
    'lessons.get@1': 'host-server',
    'progress.save@1': 'host-server',
  });
});
