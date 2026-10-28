// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  buildAppConfig,
  defaultWebLLMModel,
  type WebLLMAppConfig,
  type WebLLMModelRecord,
} from './model-record.js';

export interface CheckWebLLMModelOptions {
  readonly model?: WebLLMModelRecord;
}

export type WebLLMModelAvailability =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'downloadable'; readonly bytes: number; readonly siteStorage: true };

/** Structural seam for the lazily imported cache API, without extensionless declarations. */
export interface WebLLMCacheModule {
  hasModelInCache(modelId: string, appConfig: WebLLMAppConfig): Promise<boolean>;
}

export async function probeWebLLMModel(
  options: CheckWebLLMModelOptions,
  loadModule: () => Promise<WebLLMCacheModule>,
): Promise<WebLLMModelAvailability> {
  const model = options.model ?? defaultWebLLMModel;
  const appConfig = buildAppConfig(model);
  const navigator = globalThis.navigator as (Navigator & { readonly gpu?: unknown }) | undefined;
  if (navigator?.gpu === undefined) return { status: 'unavailable' };
  try {
    const module = await loadModule();
    return (await module.hasModelInCache(model.modelId, appConfig))
      ? { status: 'available' }
      : { status: 'downloadable', bytes: model.weightBytes, siteStorage: true };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Reports cached weights, never a loaded engine; this helper never downloads (ADR-0006). */
export async function checkWebLLMModel(
  options: CheckWebLLMModelOptions = {},
): Promise<WebLLMModelAvailability> {
  return probeWebLLMModel(
    options,
    async () => (await import('@mlc-ai/web-llm')) as unknown as WebLLMCacheModule,
  );
}
