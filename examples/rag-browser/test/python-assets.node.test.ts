// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { expect, test } from 'vitest';

test('development does not advertise Python assets that require a build', async () => {
  const server = await createServer({
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    mode: 'mock',
    logLevel: 'silent',
    server: { middlewareMode: true },
  });
  try {
    const module = await server.transformRequest('virtual:rag-python');
    expect(module?.code).toContain('"available":false');
    const html = await server.transformIndexHtml('/', '<html><head></head><body></body></html>');
    expect(html).toContain('name="galaxie-python-bytes" content="0"');
  } finally {
    await server.close();
  }
});
