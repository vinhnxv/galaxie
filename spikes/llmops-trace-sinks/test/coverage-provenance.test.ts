// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// Copied/adapted fixtures were reviewed against these upstream bytes. Refresh a digest only
// after reviewing whether the coverage family must change to retain its original semantics.
// The digests pin upstream bytes: they detect upstream drift, not edits to the adapted copy.
const provenance: Record<string, string> = {
  'tests/conformance/support/scripted-chat-model.ts':
    'ce1624ee35f3d34bb3e9178512e454c89b4f63314360a90a41819c16a8b4b06a',
  'packages/adapter-adk/test/support/adk-env.ts':
    'beb3132c79e93d5f4dff579c7a16d2b241abb783d26ac9eaa7d58d9c88882836',
  'tests/conformance/support/adk.ts':
    '7928d586f7e5e162e3f1c9c0a4a9dc4afda40ea7bab26a2030b7faf7dd53bcf3',
  'tests/conformance/cases-adk/fixtures.json':
    '1d804e69cd19e7f1011f8cfbd99330ea4247564d858a17394f158c32b82e55ac',
  'examples/rag-browser/test/support/python.node.ts':
    '4a0c7cc2191b8c0de9677f71dc1a3348481f53f19c7d50e7b9c41fa9c5b5ee53',
  'tests/conformance/pyodide.node.test.ts':
    '7a85fce59d93c4af212d4b22e8bee70aee617049495841a96cae60601fd12baa',
  'examples/rag-browser/test/support/adk-go-ref/run.ts':
    '87ba8665df14b71ce7e860a20ac3a6d1eb8ed2e99cc2b6c79c94f29345f8f1ba',
  'examples/rag-browser/test/support/adk-go-reference.node.ts':
    '3ff29ed3ce685fcafdbf777200b5154ea226da77566c0db8c06221ceda4200f1',
  'tests/conformance/cases-adk-go/scripts.json':
    '1efe254c89c1cb9c4c92c6d5ae6f26cff3c2b6d6fe3022c4e34dcf168cfc4a37',
  'tests/conformance/golden-adk-go/capability-tool.json':
    '306a465183e214fd68d2d18b2392709b891ba2416d5a89a81eb9b2bcfa7f10f6',
};

test.each(Object.entries(provenance))('coverage fixture provenance: %s', (path, expected) => {
  const actual = createHash('sha256')
    .update(readFileSync(new URL(`../../../${path}`, import.meta.url)))
    .digest('hex');
  expect(
    actual,
    `${path}: fixture drift; review the copied coverage fixture and refresh its recorded SHA-256 after review`,
  ).toBe(expected);
});
