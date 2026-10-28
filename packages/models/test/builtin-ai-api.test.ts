// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertCallable,
  type BuiltInAIAvailability,
  checkBuiltInAI,
  prepareBuiltInAI,
} from '../src/builtin-ai/api.js';
import { classifyBuiltInAIError } from '../src/builtin-ai/classify.js';
import { ModelError, ModelProviderError } from '../src/errors.js';
import { FakeLanguageModel, installLanguageModel } from './support/fake-language-model.js';

const languages = { inputLanguages: ['en'], outputLanguages: ['en'] };
const expectedLanguages = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};
let restore = (): void => {};
afterEach(() => {
  restore();
  vi.unstubAllGlobals();
});

describe('Built-in AI availability and preparation', () => {
  it('reports a missing API without touching any session', async () => {
    restore = installLanguageModel(undefined);
    expect(await checkBuiltInAI(languages)).toBe('unavailable');
    await expect(assertCallable(languages)).rejects.toMatchObject({
      code: 'unavailable',
      reason: 'no_api',
    });
    await expect(prepareBuiltInAI(languages)).rejects.toMatchObject({
      code: 'unavailable',
      reason: 'no_api',
    });
  });

  it.each<BuiltInAIAvailability>(['available', 'downloadable', 'downloading', 'unavailable'])(
    'checks %s with the expected languages and never creates',
    async (availability) => {
      const fake = new FakeLanguageModel({ availability: async () => availability });
      restore = installLanguageModel(fake);
      expect(await checkBuiltInAI(languages)).toBe(availability);
      expect(fake.availabilityCalls).toEqual([expectedLanguages]);
      expect(fake.creates).toEqual([]);
    },
  );

  it('returns unavailable for unsupported languages and rejected availability', async () => {
    const fake = new FakeLanguageModel({ availability: async () => 'unavailable' });
    restore = installLanguageModel(fake);
    const vietnamese = { inputLanguages: ['vi'], outputLanguages: ['vi'] };
    await expect(assertCallable(vietnamese)).rejects.toMatchObject({
      code: 'unavailable',
      reason: 'unsupported_languages',
    });
    await expect(prepareBuiltInAI(vietnamese)).rejects.toMatchObject({
      code: 'unavailable',
      reason: 'unsupported_languages',
    });
    expect(fake.availabilityCalls[0]?.expectedInputs[0]?.languages).toEqual(['vi']);
    expect(fake.creates).toEqual([]);
    restore();
    restore = installLanguageModel(
      new FakeLanguageModel({
        availability: async () => {
          throw new Error('private browser text');
        },
      }),
    );
    expect(await checkBuiltInAI(languages)).toBe('unavailable');
    await expect(assertCallable(languages)).rejects.toMatchObject({
      reason: 'unsupported_languages',
    });
  });

  it.each(['downloadable', 'downloading'] as const)(
    'never downloads %s during a model call, with either activation state',
    async (availability) => {
      const fake = new FakeLanguageModel({ availability: async () => availability });
      restore = installLanguageModel(fake);
      for (const isActive of [false, true]) {
        vi.stubGlobal('navigator', { userActivation: { isActive } });
        await expect(assertCallable(languages)).rejects.toMatchObject({
          code: 'unavailable',
          reason: 'download_required',
        });
      }
      expect(fake.creates).toEqual([]);
    },
  );

  it.each(['downloadable', 'downloading'] as const)(
    'requires activation to prepare %s, including when activation is absent',
    async (availability) => {
      const fake = new FakeLanguageModel({ availability: async () => availability });
      restore = installLanguageModel(fake);
      for (const navigator of [{ userActivation: { isActive: false } }, {}]) {
        vi.stubGlobal('navigator', navigator);
        await expect(prepareBuiltInAI(languages)).rejects.toMatchObject({
          code: 'unavailable',
          reason: 'activation_required',
        });
      }
      expect(fake.creates).toEqual([]);
    },
  );

  it.each(['downloadable', 'downloading', 'available'] as const)(
    'prepares %s, forwards content-free progress, and destroys the session',
    async (availability) => {
      const fake = new FakeLanguageModel({ availability: async () => availability });
      restore = installLanguageModel(fake);
      vi.stubGlobal('navigator', { userActivation: { isActive: availability !== 'available' } });
      const onProgress = vi.fn();
      await prepareBuiltInAI({ ...languages, onProgress });
      expect(fake.creates).toEqual([{ ...expectedLanguages, monitor: expect.any(Function) }]);
      expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual(
        [0, 1].map((fraction) => ({
          phase: 'download',
          fraction,
          elapsedSeconds: expect.any(Number),
        })),
      );
      expect(onProgress.mock.calls.every(([progress]) => progress.elapsedSeconds >= 0)).toBe(true);
      expect(fake.sessions[0]?.destroys).toBe(1);
    },
  );

  it('maps a rejected download without retaining browser text', async () => {
    const fake = new FakeLanguageModel({
      create: async () => {
        throw new DOMException('private prompt sentence', 'NetworkError');
      },
    });
    restore = installLanguageModel(fake);
    const error = await prepareBuiltInAI(languages).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'unavailable', reason: 'download_failed' });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('private prompt sentence');
    expect(JSON.stringify(error)).not.toContain('private prompt sentence');
  });

  it('preserves abort reasons before and during create', async () => {
    const entered = Promise.withResolvers<void>();
    const blocked = Promise.withResolvers<void>();
    const fake = new FakeLanguageModel({
      create: async () => {
        entered.resolve();
        await blocked.promise;
      },
    });
    restore = installLanguageModel(fake);
    const controller = new AbortController();
    const reason = new Error('host abort');
    const result = prepareBuiltInAI({ ...languages, signal: controller.signal });
    const rejection = expect(result).rejects.toBe(reason);
    await entered.promise;
    controller.abort(reason);
    await rejection;
    await expect(prepareBuiltInAI({ ...languages, signal: controller.signal })).rejects.toBe(
      reason,
    );
    expect(fake.creates).toHaveLength(1);
    expect(fake.sessions).toEqual([]);
    blocked.resolve();
  });
});

describe('Built-in AI error classification', () => {
  it.each([
    ['NotSupportedError', 'create', { code: 'unavailable', reason: 'unsupported_languages' }],
    ['NotSupportedError', 'prompt', { code: 'invalid' }],
    ...(['create', 'prompt'] as const).flatMap(
      (step) =>
        [
          ['QuotaExceededError', step, { code: 'invalid' }],
          ['NetworkError', step, { code: 'unavailable', reason: 'download_failed' }],
          ['NotAllowedError', step, { code: 'unavailable', reason: 'not_allowed' }],
          ['TypeError', step, { code: 'invalid' }],
          ['SyntaxError', step, undefined],
          ['UnknownError', step, undefined],
        ] as const,
    ),
  ] as const)('classifies %s at %s without reading its message', (name, step, expected) => {
    const error = new DOMException('private prompt sentence', name);
    Object.defineProperty(error, 'message', {
      get() {
        throw new Error('Message must not be read.');
      },
    });
    const classification = classifyBuiltInAIError(error, step);
    expect(classification).toEqual(expected);
    const mapped =
      classification === undefined
        ? new ModelProviderError()
        : new ModelError(
            classification.code,
            classification.code === 'unavailable' ? classification.reason : undefined,
          );
    expect(mapped).not.toHaveProperty('cause');
    expect(String(mapped)).not.toContain('private prompt sentence');
    expect(JSON.stringify(mapped)).not.toContain('private prompt sentence');
  });
});
