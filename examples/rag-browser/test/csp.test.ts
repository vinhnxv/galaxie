// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, test } from 'vitest';
import { cspDirectives } from '../src/host/csp.js';
import { checkWorkerUrl } from '../src/host/trusted-types.js';

test('keeps strict script, worker, connection and Trusted Types directives', () => {
  for (const mode of ['mock', 'production']) {
    const csp = cspDirectives(mode);
    expect(csp['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp['require-trusted-types-for']).toEqual(["'script'"]);
    expect(csp['trusted-types']).toEqual(['default']);
    expect(csp['form-action']).toEqual(["'none'"]);
    expect(csp['connect-src']).toEqual(
      mode === 'mock'
        ? ["'self'"]
        : [
            "'self'",
            'https://huggingface.co',
            'https://*.hf.co',
            'https://raw.githubusercontent.com',
          ],
    );
  }
  const base = 'https://host.example/page';
  const allowed = ['/assets/retrieval.js', '/assets/webllm.js'];
  expect(checkWorkerUrl(allowed[0] ?? '', allowed, base)).toBe(
    'https://host.example/assets/retrieval.js',
  );
  expect(checkWorkerUrl(allowed[1] ?? '', allowed, base)).toBe(
    'https://host.example/assets/webllm.js',
  );
  for (const value of [
    'https://attacker.example/assets/retrieval.js',
    '/other.js',
    'blob:https://host.example/x',
    '/assets/retrieval.js?x=1',
  ])
    expect(() => checkWorkerUrl(value, allowed, base)).toThrow(
      'The worker script URL is not allowed.',
    );
});
