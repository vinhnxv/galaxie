// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { knownPackages } from '../../packages/create/src/packages.js';
import { launchPackages } from '../../scripts/standalone-core.js';

test('create tarball inventory equals the seven launch packages', () => {
  expect(knownPackages).toEqual([
    '@galaxie-ai/ui-protocol',
    '@galaxie-ai/core',
    '@galaxie-ai/adapter-kit',
    '@galaxie-ai/adapter-langgraph',
    '@galaxie-ai/models',
    '@galaxie-ai/storage-indexeddb',
    '@galaxie-ai/react',
  ]);
  expect(knownPackages).toEqual(launchPackages);
});
