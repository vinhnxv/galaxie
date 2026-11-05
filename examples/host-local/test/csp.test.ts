// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { defaultWebLLMModel } from '@galaxie/models/webllm';
import { describe, expect, it } from 'vitest';
import { cspDirectives, cspHeader } from '../src/csp.js';

describe('host CSP', () => {
  it('restricts mock traffic and Trusted Types', () => {
    expect(cspDirectives('mock')['connect-src']).toEqual(["'self'"]);
    expect(cspDirectives('mock')['trusted-types']).toEqual(["'none'"]);
  });

  it('allows only the pinned download hosts in default mode', () => {
    const sources = cspDirectives('production')['connect-src'];
    expect(sources).toEqual([
      "'self'",
      'https://huggingface.co',
      'https://*.hf.co',
      'https://raw.githubusercontent.com',
    ]);
    for (const url of [defaultWebLLMModel.modelUrl, defaultWebLLMModel.libraryUrl])
      expect(sources).toContain(new URL(url).origin);
    expect(cspDirectives('production')['trusted-types']).toEqual(['default']);
  });

  it.each(['mock', 'production'])('keeps script and document controls in %s', (mode) => {
    expect(cspDirectives(mode)['require-trusted-types-for']).toEqual(["'script'"]);
    expect(cspDirectives(mode)['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(cspDirectives(mode)['frame-ancestors']).toEqual(["'none'"]);
    expect(cspDirectives(mode)['form-action']).toEqual(["'none'"]);
    expect(cspHeader(mode).split('; ')).toContain("form-action 'none'");
    expect(cspHeader(mode)).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
  });
});
