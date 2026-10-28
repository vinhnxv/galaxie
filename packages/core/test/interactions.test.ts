// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { parseInteractionRequest } from '../src/index.js';

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
