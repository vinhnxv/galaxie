// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { OpenAIClient } from '@langchain/openai';
import { describe, expect, it } from 'vitest';
import { classifyOpenAIError } from '../src/openai/classify.js';

describe('OpenAI-compatible error classification', () => {
  it.each([
    [401, 'not_allowed'],
    [403, 'not_allowed'],
    [429, 'rate_limited'],
    [408, 'endpoint_failed'],
    [500, 'endpoint_failed'],
    [503, 'endpoint_failed'],
  ])('classifies status %s without retaining endpoint text', (status, reason) => {
    const error = OpenAIClient.APIError.generate(
      status,
      { message: 'body-marker' },
      '',
      new Headers(),
    );
    error.name = 'RenamedByAsyncCaller';
    expect(classifyOpenAIError(error)).toEqual({ code: 'unavailable', reason });
  });

  it('classifies SDK network and timeout instances without constructor names', () => {
    expect(
      classifyOpenAIError(new OpenAIClient.APIConnectionError({ message: 'body-marker' })),
    ).toEqual({ code: 'unavailable', reason: 'network' });
    expect(classifyOpenAIError(new OpenAIClient.APIConnectionTimeoutError())).toEqual({
      code: 'unavailable',
      reason: 'endpoint_failed',
    });
    expect(
      classifyOpenAIError(Object.assign(new Error('body-marker'), { name: 'TimeoutError' })),
    ).toEqual({ code: 'unavailable', reason: 'endpoint_failed' });
    expect(classifyOpenAIError({ name: 'APIConnectionError' })).toBeUndefined();
  });

  it.each([400, 404, 409, 422, 499])('leaves status %s as a provider failure', (status) => {
    expect(
      classifyOpenAIError(OpenAIClient.APIError.generate(status, {}, '', new Headers())),
    ).toBeUndefined();
  });

  it.each([new SyntaxError('body-marker'), new Error('body-marker'), undefined])(
    'leaves malformed, refused and unknown replies as provider failures',
    (error) => {
      expect(classifyOpenAIError(error)).toBeUndefined();
    },
  );

  it.each(['length', 'content_filter'])(
    'classifies the SDK parse failure for %s',
    async (finish_reason) => {
      const client = new OpenAIClient({
        apiKey: 'fake-credential',
        logLevel: 'off',
        fetch: async () =>
          Response.json({
            choices: [{ index: 0, finish_reason, message: { role: 'assistant', content: '{}' } }],
          }),
      });
      const error = await client.chat.completions
        .parse({
          model: 'fake',
          messages: [{ role: 'user', content: 'hello' }],
        })
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(classifyOpenAIError(error)).toBeUndefined();
    },
  );
});
