// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { cspMetaValue } from '../scripts/csp-meta.js';
import { cspDirectives, cspHeader } from '../src/host/csp.js';

test.each(['mock', 'production'])('meta policy preserves supported %s directives', (mode) => {
  const directives = cspDirectives(mode);
  const header = cspHeader(mode);
  const meta = cspMetaValue(mode);
  const parsed = Object.fromEntries(
    meta.split('; ').map((entry) => {
      const [directive, ...sources] = entry.split(' ');
      return [directive, sources];
    }),
  );
  expect(Object.keys(parsed)).toHaveLength(Object.keys(directives).length - 1);
  for (const [directive, sources] of Object.entries(directives)) {
    if (directive === 'frame-ancestors') expect(parsed[directive]).toBeUndefined();
    else expect(parsed[directive]).toEqual(sources);
  }
  expect(meta).not.toContain('frame-ancestors');
  expect(meta).toBe(header.replace("; frame-ancestors 'none'", ''));
  expect(cspHeader(mode)).toBe(header);
  expect(cspHeader(mode)).toBe(
    Object.entries(directives)
      .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
      .join('; '),
  );
  expect(cspHeader(mode)).toContain("frame-ancestors 'none'");
  expect(cspDirectives(mode)).toEqual(directives);
});
