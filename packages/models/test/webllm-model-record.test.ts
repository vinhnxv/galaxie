// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { WebLLMError, WebLLMProviderError } from '../src/errors.js';
import { classifyWebLLMError } from '../src/webllm/classify.js';
import {
  buildAppConfig,
  defaultWebLLMModel,
  validateModelRecord,
} from '../src/webllm/model-record.js';

describe('WebLLM model record and content-free errors', () => {
  it('pins the default artifacts, required feature, context and cache', () => {
    const config = buildAppConfig(defaultWebLLMModel);
    expect(config.cacheBackend).toBe('cache');
    expect(config.model_list[0]).toEqual({
      model_id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
      model:
        'https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC/resolve/9bd564b064631febf14deadcac492efb761d60c3/',
      model_lib:
        'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/00fe7a40e57e5e8eb9fef87526a4bf28ad5846c0/web-llm-models/v0_2_86/base/Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm',
      required_features: ['shader-f16'],
      vram_required_MB: 1629.75,
      overrides: { context_window_size: 4096 },
      integrity: {
        config: 'sha256-faSVQhLT8hqRzD5pPRefYyE/1XNWeWhH9l1/lUeKH54=',
        model_lib: 'sha256-Q2Rira1AfgkU0jUP1FKlo9mD4AMdd8lAxD6jUcjNMAA=',
        tokenizer: { 'tokenizer.json': 'sha256-wDghF+oynN8JcEETL21zWSS2l5JNb2/DlFcT6WzodTk=' },
        onFailure: 'error',
      },
    });
    expect(defaultWebLLMModel.weightBytes).toBe(868547584);
    expect(Object.isFrozen(defaultWebLLMModel)).toBe(true);
  });

  it.each([
    { integrity: { ...defaultWebLLMModel.integrity, library: undefined } },
    { modelUrl: 'prompt sentence' },
    { onFailure: 'warn' },
    { integrity: { ...defaultWebLLMModel.integrity, onFailure: 'warn' } },
    { modelUrl: 'https://example.test/resolve/main/' },
    { modelUrl: 'https://example.test/models/' },
  ])('rejects an incomplete, mutable or downgraded record without its text', (change) => {
    let error: unknown;
    try {
      validateModelRecord({ ...defaultWebLLMModel, ...change });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      name: 'GalaxieError',
      code: 'invalid',
      message: 'The WebLLM request is invalid.',
    });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('example.test');
  });

  it('resolves a host model URL while keeping its origin-relative library', () => {
    const config = buildAppConfig(
      {
        ...defaultWebLLMModel,
        modelUrl: '/models/qwen/resolve/0123456789012345678901234567890123456789/',
        libraryUrl: '/library.wasm',
      },
      'https://app.test/page',
    );
    expect(config.model_list[0]?.model).toBe(
      'https://app.test/models/qwen/resolve/0123456789012345678901234567890123456789/',
    );
    expect(config.model_list[0]?.model_lib).toBe('/library.wasm');
    expect(config.model_list[0]?.integrity.onFailure).toBe('error');
  });

  it.each([
    ['WebGPUNotAvailableError', 'unavailable', 'no_webgpu'],
    ['ShaderF16SupportError', 'unavailable', 'no_shader_f16'],
    ['FeatureSupportError', 'unavailable', 'no_shader_f16'],
    ['Error: Unable to find a compatible GPU', 'unavailable', 'no_adapter'],
    ['Error: Cannot initialize runtime because of requested', 'unavailable', 'adapter_limits'],
    ['DeviceLostError', 'unavailable', 'device_lost'],
    ['IntegrityError', 'unavailable', 'integrity'],
    ['ModelNotLoadedError', 'unavailable', 'device_lost'],
    ['WorkerEngineModelNotLoadedError', 'unavailable', 'device_lost'],
    ['ContextWindowSizeExceededError', 'invalid', undefined],
  ])('classifies %s and drops all engine text', (prefix, code, reason) => {
    const text = `${prefix}: private prompt sentence`;
    const expected = reason === undefined ? { code } : { code, reason };
    expect(classifyWebLLMError(text)).toEqual(expected);
    expect(classifyWebLLMError(new Error(text))).toEqual(expected);
    expect(JSON.stringify(classifyWebLLMError(text))).not.toContain('private');
  });

  it('uses fixed error messages without causes', () => {
    expect(classifyWebLLMError('unknown private sentence')).toBeUndefined();
    for (const error of [
      new WebLLMError('invalid'),
      new WebLLMError('unsupported'),
      new WebLLMError('unavailable', 'integrity'),
      new WebLLMProviderError(),
    ]) {
      expect(error).not.toHaveProperty('cause');
      expect(error.message).not.toContain('private');
    }
  });
});
