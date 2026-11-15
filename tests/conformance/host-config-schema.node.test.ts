// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostConfigJsonSchema } from '@galaxie-ai/core/config';
import { expect, onTestFinished, test } from 'vitest';
import {
  verifyHostConfigSchema,
  writeHostConfigSchema,
} from '../../scripts/build-host-config-schema.js';

test('schema generation verifies exact bytes and detects drift without a distribution build', () => {
  const directory = mkdtempSync(join(tmpdir(), 'galaxie-host-config-schema-'));
  onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
  const target = join(directory, 'config/host-config.schema.json');
  const schema = hostConfigJsonSchema();
  writeHostConfigSchema(schema, target);
  expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(schema);
  expect(() => verifyHostConfigSchema(schema, target)).not.toThrow();
  writeFileSync(target, '{}\n');
  expect(() => verifyHostConfigSchema(schema, target)).toThrow(
    'Host configuration schema mismatch.',
  );
});
