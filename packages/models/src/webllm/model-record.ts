// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { ModelError } from '../errors.js';

export interface WebLLMModelRecord {
  readonly modelId: string;
  readonly modelUrl: string;
  readonly libraryUrl: string;
  readonly contextWindow: number;
  readonly weightBytes: number;
  readonly vramRequiredMB?: number;
  readonly requiredFeatures?: readonly string[];
  readonly integrity: {
    readonly config: string;
    readonly library: string;
    readonly tokenizer: string;
  };
}

export interface WebLLMAppConfig {
  model_list: {
    model_id: string;
    model: string;
    model_lib: string;
    overrides: { context_window_size: number };
    required_features: string[];
    vram_required_MB?: number;
    integrity: {
      config: string;
      model_lib: string;
      tokenizer: Record<string, string>;
      onFailure: 'error';
    };
  }[];
  cacheBackend: 'cache';
}

export const defaultWebLLMModel: WebLLMModelRecord = Object.freeze({
  modelId: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  modelUrl:
    'https://huggingface.co/mlc-ai/Qwen2.5-1.5B-Instruct-q4f16_1-MLC/resolve/9bd564b064631febf14deadcac492efb761d60c3/',
  libraryUrl:
    'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/00fe7a40e57e5e8eb9fef87526a4bf28ad5846c0/web-llm-models/v0_2_86/base/Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm',
  contextWindow: 4096,
  weightBytes: 868547584,
  vramRequiredMB: 1629.75,
  requiredFeatures: Object.freeze(['shader-f16']),
  integrity: Object.freeze({
    config: 'sha256-faSVQhLT8hqRzD5pPRefYyE/1XNWeWhH9l1/lUeKH54=',
    library: 'sha256-Q2Rira1AfgkU0jUP1FKlo9mD4AMdd8lAxD6jUcjNMAA=',
    tokenizer: 'sha256-wDghF+oynN8JcEETL21zWSS2l5JNb2/DlFcT6WzodTk=',
  }),
});

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function validUrl(value: unknown, allowSearch = false): value is string {
  if (
    typeof value !== 'string' ||
    // Weight shards have no SRI, so absolute URLs must not travel in cleartext.
    (!value.startsWith('/') && !value.startsWith('https://')) ||
    value.startsWith('//')
  )
    return false;
  try {
    const url = new URL(value, 'https://validation.invalid/');
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (allowSearch || !url.search) &&
      !url.hash
    );
  } catch {
    return false;
  }
}
function sri(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^(sha256-[A-Za-z0-9+/]{43}=|sha384-[A-Za-z0-9+/]{64}|sha512-[A-Za-z0-9+/]{86}==)$/.test(value)
  );
}

export function validateModelRecord(value: unknown): asserts value is WebLLMModelRecord {
  if (
    !object(value) ||
    'onFailure' in value ||
    typeof value['modelId'] !== 'string' ||
    !value['modelId'].trim() ||
    !validUrl(value['modelUrl']) ||
    !/\/resolve\/[a-fA-F0-9]{40}\//.test(
      new URL(value['modelUrl'], 'https://validation.invalid/').pathname,
    ) ||
    !validUrl(value['libraryUrl'], true) ||
    !Number.isSafeInteger(value['contextWindow']) ||
    (value['contextWindow'] as number) <= 0 ||
    !Number.isSafeInteger(value['weightBytes']) ||
    (value['weightBytes'] as number) <= 0 ||
    (value['vramRequiredMB'] !== undefined &&
      (typeof value['vramRequiredMB'] !== 'number' ||
        !Number.isFinite(value['vramRequiredMB']) ||
        value['vramRequiredMB'] <= 0)) ||
    (value['requiredFeatures'] !== undefined &&
      (!Array.isArray(value['requiredFeatures']) ||
        !value['requiredFeatures'].every((feature: unknown) => typeof feature === 'string'))) ||
    !object(value['integrity']) ||
    'onFailure' in value['integrity'] ||
    !sri(value['integrity']['config']) ||
    !sri(value['integrity']['library']) ||
    !sri(value['integrity']['tokenizer'])
  )
    throw new ModelError('invalid');
}

export function buildAppConfig(
  record: WebLLMModelRecord,
  pageUrl: string | undefined = globalThis.location?.href,
): WebLLMAppConfig {
  validateModelRecord(record);
  let model: string;
  try {
    model = new URL(record.modelUrl, pageUrl).href;
  } catch {
    throw new ModelError('invalid');
  }
  return {
    cacheBackend: 'cache',
    model_list: [
      {
        model_id: record.modelId,
        model,
        model_lib: record.libraryUrl,
        overrides: { context_window_size: record.contextWindow },
        required_features: [...(record.requiredFeatures ?? [])],
        ...(record.vramRequiredMB === undefined ? {} : { vram_required_MB: record.vramRequiredMB }),
        integrity: {
          config: record.integrity.config,
          model_lib: record.integrity.library,
          tokenizer: { 'tokenizer.json': record.integrity.tokenizer },
          onFailure: 'error',
        },
      },
    ],
  };
}
