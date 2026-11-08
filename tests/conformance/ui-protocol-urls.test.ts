// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { isAllowedUrl, normalizeUrlAllowlist } from '@galaxie-ai/core';
import type { Catalog, SurfaceContext } from '@galaxie-ai/ui-protocol';
import { reduceBatch } from '@galaxie-ai/ui-protocol';
import { expect, test } from 'vitest';

const allowlist = normalizeUrlAllowlist([
  'https://images.example',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://[::1]:8080',
]);
const catalog: Catalog = {
  id: 'url-test',
  components: {
    Image: {
      urls: ['url'],
      props: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate(value: unknown) {
            return value !== null &&
              typeof value === 'object' &&
              'url' in value &&
              typeof value.url === 'string' &&
              Object.keys(value).length === 1
              ? { value }
              : { issues: [] };
          },
        },
      },
    },
  },
};
const context: SurfaceContext = {
  binding: { region: 'main', a2uiSurfaceId: 'url-surface', catalogId: catalog.id },
  catalog,
  limits: { payloadBytes: 1_048_576, components: 50 },
  isAllowedUrl: (url) => isAllowedUrl(url, allowlist),
};

const urlCases: readonly [string, boolean][] = [
  ['https://images.example/photo?size=small&name=value', true],
  ['https://images.example:443/photo', true],
  ['https://other.example/photo', false],
  ['http://images.example/photo', false],
  ['https://user:password@images.example/photo', false],
  ['https://user@images.example/photo', false],
  ['https://images.ex ample/photo', false],
  ['http://localhost:8080/photo?size=small', true],
  ['http://127.0.0.1:8080/photo', true],
  ['http://[::1]:8080/photo', true],
  ['http://192.168.1.2/photo', false],
  ['javascript:alert(1)', false],
];

test.each(urlCases)('literal URL %s agrees with core (%s)', (url, allowed) => {
  const direct = isAllowedUrl(url, allowlist);
  const result = reduceBatch(
    undefined,
    [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'url-surface',
          components: [{ id: 'root', component: 'Image', url }],
        },
      },
    ],
    context,
  );
  expect(direct).toBe(allowed);
  expect(result.ok).toBe(direct);
  if (!result.ok) expect(result.code).toBe('URL_NOT_ALLOWED');
});

test('single-attribute URLs also reject whitespace that URL parsing alone normalizes', () => {
  const url = '\thttps://images.example/photo';
  expect(isAllowedUrl(url, allowlist)).toBe(true);
  const result = reduceBatch(
    undefined,
    [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'url-surface',
          components: [{ id: 'root', component: 'Image', url }],
        },
      },
    ],
    context,
  );
  expect(result).toEqual({ ok: false, code: 'URL_NOT_ALLOWED' });
});
