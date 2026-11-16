// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Turbopack aliases resolve from the app root, not the importing file. Resolve
// relative .js specifiers as extensionless imports while retaining authored bytes.
const ts = require('@typescript/typescript6');

module.exports = function relativeImports(source) {
  const file = ts.createSourceFile(this.resourcePath, source, ts.ScriptTarget.Latest, true);
  const ranges = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) && /^\.{1,2}\/.*\.js$/.test(node.text)) {
      const parent = node.parent;
      if (
        ts.isImportDeclaration(parent) ||
        ts.isExportDeclaration(parent) ||
        (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword)
      ) {
        ranges.push([node.end - 4, node.end - 1]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const [start, end] of ranges.reverse()) source = source.slice(0, start) + source.slice(end);
  return source;
};
