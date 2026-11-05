// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  checkInteractionUrls,
  createRuntime,
  isAllowedUrl,
  parseInteractionRequest,
} from '../src/index.js';

const request = {
  surfaceId: 'main',
  viewRevision: 'r1',
  component: 'edu.Quiz/v1',
  props: { nested: [false, null, { count: 2 }] },
};

describe('interaction requests', () => {
  it('accepts a plain request with nested JSON props', () => {
    expect(parseInteractionRequest(request)).toEqual(request);
  });

  it.each([
    { ...request, surfaceId: '' },
    { ...request, viewRevision: '' },
    { ...request, component: 'Quiz/v1' },
    { ...request, component: 'edu.Quiz/vx' },
    { ...request, props: [] },
    ...[new Date(), 1n, () => undefined, undefined, Number.NaN, Infinity].map((value) => ({
      ...request,
      props: { value },
    })),
    { ...request, extra: true },
    { ...request, props: new (class Props {})() },
  ])('rejects malformed requests without throwing', (value) => {
    expect(parseInteractionRequest(value)).toBeUndefined();
  });

  it('rejects cycles', () => {
    const props: Record<string, unknown> = {};
    props['self'] = props;
    expect(parseInteractionRequest({ ...request, props })).toBeUndefined();
  });
});

const allowedOrigins = [
  'https://cdn.example.com',
  'https://cdn.example.com:8443',
  'http://localhost:9000',
  'http://127.0.0.1',
  'http://[::1]:8000',
];

describe('interaction URL policy', () => {
  it('rejects cyclic props inspection without throwing', () => {
    const props: Record<string, unknown> = {};
    props['nested'] = props;
    expect(checkInteractionUrls(props, [])).toBe(false);
  });
  it('requires the HTTP protocol rule even when an origin is supplied directly', () => {
    expect(isAllowedUrl('http://cdn.example.com/x', ['http://cdn.example.com'])).toBe(false);
    expect(isAllowedUrl('file:///tmp/file', ['null'])).toBe(false);
  });
  it.each(allowedOrigins)('allows paths on the exact origin %s', (origin) => {
    expect(isAllowedUrl(`${origin}/image.png?size=1#image`, allowedOrigins)).toBe(true);
  });
  it.each([
    'https://evil.example/?d=url-canary',
    'https://cdn.example.com:8444/x',
    'http://cdn.example.com/x',
    'https://user:pass@cdn.example.com/x',
    '//evil.example/x',
    '\\\\evil.example/x',
    '/\\evil.example/x',
    '\\/evil.example/x',
    'https:evil.example',
    'http:evil.example/x',
    'wss:evil.example',
    'ftp:evil.example',
    'JaVaScRiPt:alert(1)',
    ' java\tscript:alert(1)',
    'DA\nTA:text/html,x',
    'BlOb:https://cdn.example.com/id',
    'FiLe:///etc/file',
    'filesystem:https://cdn.example.com/x',
    'vbscript:msgbox(1)',
    'custom://cdn.example.com/x',
  ])('rejects URL candidate %s', (value) => {
    expect(checkInteractionUrls({ nested: [{ value }] }, allowedOrigins)).toBe(false);
    expect(isAllowedUrl(value, allowedOrigins)).toBe(false);
  });
  it.each(['Note: see page 3', '10:30', 'mailto:a@b.c', 'ratio:3', ''])(
    'keeps plain text %s',
    (value) => {
      expect(checkInteractionUrls({ nested: [false, null, { value }] }, [])).toBe(true);
    },
  );
  it('normalizes URL parser whitespace and searches nested arrays and objects', () => {
    expect(
      checkInteractionUrls(
        {
          values: [
            '\u0001 https://cdn.example.com/x\u0020',
            { url: 'https://cdn.exa\tmple.com/y' },
          ],
        },
        allowedOrigins,
      ),
    ).toBe(true);
    expect(
      checkInteractionUrls(
        { values: [0, { nested: ['allowed text', 'https://evil.example/x'] }] },
        allowedOrigins,
      ),
    ).toBe(false);
    expect(checkInteractionUrls({ value: 'https://cdn.example.com/x' }, [])).toBe(false);
  });
  it.each([
    'https://cdn.example.com/path',
    'https://cdn.example.com/path/..',
    'https://cdn.example.com?query=1',
    'https://cdn.example.com?',
    'https://cdn.example.com#fragment',
    'https://cdn.example.com#',
    'https://user:pass@cdn.example.com',
    'https://@cdn.example.com',
    'http://cdn.example.com',
    'javascript:alert(1)',
    '//cdn.example.com',
    'https:cdn.example.com',
  ])('rejects invalid allowlist origin without exposing it: %s', (origin) => {
    expect(() =>
      createRuntime({ appId: 'urls', executors: [], urlAllowlist: [origin] }),
    ).toThrowError(
      expect.objectContaining({ code: 'invalid', message: 'The URL allowlist is invalid.' }),
    );
  });
  it.each([null, 'https://cdn.example.com', [null], [42]])(
    'rejects malformed allowlists',
    (urlAllowlist) => {
      expect(() =>
        createRuntime({ appId: 'urls', executors: [], urlAllowlist: urlAllowlist as never }),
      ).toThrowError(expect.objectContaining({ code: 'invalid' }));
    },
  );
});
