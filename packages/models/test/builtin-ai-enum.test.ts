// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test, vi } from 'vitest';
import { BuiltInAIChatModel } from '../src/builtin-ai/index.js';
import { createStructuredDecisionModel } from '../src/decision/structured.js';
import { decisionRequest, decisionSchema } from './support/decision-request.js';
import { FakeLanguageModel, installLanguageModel } from './support/fake-language-model.js';

test('decision enums reach Built-in AI responseConstraint unchanged', async () => {
  const fake = new FakeLanguageModel({ pieces: ['{"ask":true,"route":"ask","score":0}'] });
  const restore = installLanguageModel(fake);
  try {
    const chat = new BuiltInAIChatModel({ inputLanguages: ['en'], outputLanguages: ['en'] });
    const config = vi.spyOn(chat, 'invoke');
    const result = await createStructuredDecisionModel(chat).decide(decisionRequest, {
      signal: new AbortController().signal,
      maxTokens: 64,
    });
    expect(config).toHaveBeenCalledExactlyOnceWith(
      expect.any(Array),
      expect.objectContaining({ jsonSchema: decisionSchema }),
    );
    const schema = config.mock.calls[0]?.[1]?.jsonSchema;
    expect(fake.sessions[0]?.prompts[0]?.options.responseConstraint).toBe(schema);
    expect(fake.sessions[0]?.prompts[0]?.options.responseConstraint).toEqual(decisionSchema);
    expect(fake.sessions[0]?.destroys).toBe(1);
    expect(fake.creates).toHaveLength(1);
    expect(result).not.toHaveProperty('usage');
  } finally {
    restore();
  }
});
