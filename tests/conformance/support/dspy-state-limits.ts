// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { MAX_BRIDGE_BYTES } from '../../../packages/adapter-pyodide/src/bridge.js';
import base from '../cases-dspy/state/state-predict-demos.json' with { type: 'json' };
import type { StateSpec } from './dspy-state.js';

export const stateLimitSpec: StateSpec = {
  state: 'synthetic',
  question: 'What is the capital of France?',
  replies: [{ text: '[[ ## answer ## ]]\nParis\n[[ ## completed ## ]]' }],
};
export const stateLimitCases: Readonly<
  Record<string, { readonly bytes: number; readonly code?: string }>
> = {
  'state-limit-accepted': { bytes: 256 * 1024 },
  'state-limit-file-over': { bytes: MAX_BRIDGE_BYTES + 1, code: 'invalid' },
  'state-limit-boot-over': { bytes: MAX_BRIDGE_BYTES - 100, code: 'unsupported' },
};

/** Unique long demos keep prompt overhead visible without dominating the size probe. */
export function syntheticState(
  targetBytes: number,
  escaped = false,
): { text: string; demos: number } {
  const demos = Math.max(1, Math.floor((targetBytes - 1024) / 32768));
  const width = targetBytes < 2048 ? 32 : 32000;
  const state = {
    ...base,
    demos: Array.from({ length: demos }, (_, index) => ({
      question: `Demo ${index}: ${escaped ? '"\n'.repeat(width / 4) : 'x'.repeat(width)}`,
      answer: 'Paris',
    })),
    padding: '',
  };
  const size = new TextEncoder().encode(JSON.stringify(state)).byteLength;
  if (size > targetBytes) throw new Error('The synthetic state target is too small.');
  state.padding = 'x'.repeat(targetBytes - size);
  return { text: JSON.stringify(state), demos };
}

export function limitSources(
  suite: string,
  selected: string,
  text: string,
): Record<string, string> {
  return { 'state_suite.py': suite, 'selected.py': selected, 'state.json': text };
}
