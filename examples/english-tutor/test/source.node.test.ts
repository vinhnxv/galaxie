// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('the agent contains no hardcoded endpoints or ambient I/O', () => {
  const directory = new URL('../src/', import.meta.url);
  const forbidden = [
    'http://',
    'https://',
    'fetch(',
    'XMLHttpRequest',
    'WebSocket',
    'localStorage',
    'sessionStorage',
    'indexedDB',
    'document.',
    'window.',
    'navigator.',
    'setTimeout(',
    'setInterval(',
    'eval(',
    'new Function(',
  ];
  for (const file of readdirSync(directory).filter((file) => file.endsWith('.ts'))) {
    const source = readFileSync(new URL(file, directory), 'utf8');
    for (const token of forbidden) expect(source, `${file}: ${token}`).not.toContain(token);
  }
});
