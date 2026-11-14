// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { buildPage, csp, pageConfig } from '../browser/vite.config.js';

test('the preview forwards only the same-origin receiver path to loopback', () => {
  const proxy = pageConfig.preview?.proxy ?? {};
  expect(Object.keys(proxy)).toEqual(['/otel/v1/traces']);
  const route = proxy['/otel/v1/traces'];
  if (typeof route !== 'object') throw new Error('Missing proxy route');
  expect(new URL(route.rewrite?.('/otel/v1/traces') ?? '', String(route.target)).href).toBe(
    'http://127.0.0.1:4318/v1/traces',
  );
  expect(pageConfig.preview?.host).toBe('127.0.0.1');
  expect(pageConfig.preview?.strictPort).toBe(true);
  expect(csp).toContain("connect-src 'self'");
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
});

test('the minified page builds with exactly one copy of every shared package', async () => {
  expect(await buildPage()).toEqual({
    '@opentelemetry/api': 1,
    '@langchain/core': 1,
    '@langchain/langgraph': 1,
  });
});
