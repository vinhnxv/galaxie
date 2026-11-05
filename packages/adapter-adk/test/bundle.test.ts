// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import './support/bundle-csp/jitless.js';
import './support/bundle-csp/record-spans.js';
import { afterAll, expect, test } from 'vitest';
import { ensureAdkRuntimeEnv } from '../src/runtime-shim.js';
import {
  CANARY_ARGUMENT,
  CANARY_PROMPT,
  CANARY_REPLY,
  CANARY_RESULT,
  runProbe,
} from './bundle-probe.js';
import type { SpanRecorder } from './support/bundle-csp/span-recorder.js';

const recorder = Reflect.get(globalThis, 'adkSpanRecorder') as SpanRecorder;
ensureAdkRuntimeEnv();
afterAll(() => recorder.dispose());

test('a tool-calling agent runs through the web bundle without network or Function', async () => {
  const result = await runProbe();
  expect(result).toMatchObject({
    text: CANARY_REPLY,
    calls: ['echo'],
    toolInput: CANARY_ARGUMENT,
    network: [],
    functionConstructions: 0,
    violations: [],
  });
});

test('ADK spans reach a host provider registered before the bundle', () => {
  const spans = recorder.spans();
  expect(spans.map((span) => span.name)).toEqual(
    expect.arrayContaining(['invocation', 'invoke_agent probe', 'call_llm', 'execute_tool echo']),
  );
  const text = JSON.stringify(spans);
  for (const canary of [CANARY_PROMPT, CANARY_ARGUMENT, CANARY_RESULT])
    expect(text).not.toContain(canary);
});
