// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { cspHeader as referenceHeader } from '../../rag-browser/src/host/csp.js';
import { cspDirectives, cspHeader } from '../src/host/csp.js';
import { checkWorkerUrl } from '../src/host/trusted-types.js';

test('the host retains the complete existing mock CSP, including Trusted Types', () => {
  expect(cspHeader()).toBe(referenceHeader('mock'));
  expect(cspDirectives()['connect-src']).toEqual(["'self'"]);
  expect(cspDirectives()['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  expect(cspDirectives()['require-trusted-types-for']).toEqual(["'script'"]);
  expect(cspHeader()).not.toContain("'unsafe-eval'");
});

test('worker URLs must match an exact same-origin entry', () => {
  const base = 'https://host.example/page';
  const allowed = ['/assets/pyodide-worker.js'];
  expect(checkWorkerUrl(allowed[0] ?? '', allowed, base)).toBe(
    'https://host.example/assets/pyodide-worker.js',
  );
  for (const value of [
    '/other.js',
    '/assets/pyodide-worker.js?x=1',
    'https://other.example/assets/pyodide-worker.js',
    'blob:https://host.example/worker',
    'data:text/javascript,0',
  ])
    expect(() => checkWorkerUrl(value, allowed, base)).toThrow(
      'The worker script URL is not allowed.',
    );
});

test('default mode changes only connect-src for the pinned Hugging Face download hosts', () => {
  const { 'connect-src': connections, ...directives } = cspDirectives('production');
  const { 'connect-src': _mockConnections, ...mock } = cspDirectives('mock');
  expect(directives).toEqual(mock);
  expect(connections).toEqual(["'self'", 'https://huggingface.co', 'https://us.aws.cdn.hf.co']);
});
