// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ModelUnavailableReason } from '@galaxie/models/builtin-ai';

export type WebLLMPhase = 'offer' | 'downloading' | 'failed' | 'declined' | 'ready' | 'no_webgpu';
export type ModelState = ModelUnavailableReason | WebLLMPhase;
export type ModelControl = 'download' | 'cancel' | 'retry' | 'download-again';

export interface ModelStateEntry {
  readonly message: string;
  readonly control: ModelControl | null;
}

// Kept local so even the provider entry stays unloaded before consent. A Node test checks
// this declared weight size against defaultWebLLMModel.weightBytes after importing the entry.
export const webLLMWeightBytes = 868_547_584;
export const webLLMWeightMB: number = webLLMWeightBytes / 1_000_000;

export const modelStates: Readonly<Record<ModelState, ModelStateEntry>> = {
  no_api: { message: 'Built-in AI is absent. The mock is active.', control: null },
  unsupported_languages: {
    message: 'Built-in AI does not support English here. The mock is active.',
    control: null,
  },
  download_required: {
    message: 'Built-in AI needs a browser-managed download of unreported size. The mock is active.',
    control: null,
  },
  activation_required: {
    message: 'Built-in AI needs user activation. The mock is active.',
    control: null,
  },
  download_failed: {
    message: 'The Built-in AI download failed. The mock is active.',
    control: null,
  },
  not_allowed: { message: 'Built-in AI is not allowed here. The mock is active.', control: null },
  no_webgpu: { message: 'WebGPU is absent. WebLLM cannot be offered.', control: null },
  no_adapter: { message: 'A WebGPU adapter is unavailable. The mock is active.', control: null },
  no_shader_f16: {
    message: 'The required GPU feature is absent. The mock is active.',
    control: null,
  },
  adapter_limits: {
    message: 'The GPU limits are insufficient. The mock is active.',
    control: null,
  },
  device_lost: { message: 'The GPU device was lost. The mock is active.', control: null },
  integrity: { message: 'A model integrity check failed. The mock is active.', control: null },
  worker_failed: { message: 'The inference worker failed. The mock is active.', control: null },
  load_failed: { message: 'The local model could not load. The mock is active.', control: null },
  disposed: { message: 'The local model was disposed. The mock is active.', control: null },
  rate_limited: { message: 'The model is rate limited. The mock is active.', control: null },
  endpoint_failed: { message: 'The model endpoint failed. The mock is active.', control: null },
  network: { message: 'The model network operation failed. The mock is active.', control: null },
  offer: {
    message:
      'WebLLM is optional: download 868,547,584 bytes (868.547584 MB) of weights. Additional runtime and tokenizer files are required. The mock stays active until loading finishes.',
    control: 'download',
  },
  downloading: { message: 'WebLLM is downloading. The mock is active.', control: 'cancel' },
  failed: { message: 'WebLLM could not load. The mock is active.', control: 'retry' },
  declined: {
    message: 'The WebLLM download was declined. The mock is active.',
    control: 'download-again',
  },
  ready: { message: 'WebLLM is ready and active in this browser.', control: null },
} satisfies Record<ModelState, ModelStateEntry>;

export const controlLabels: Readonly<Record<ModelControl, string>> = {
  download: 'Download',
  cancel: 'Cancel',
  retry: 'Retry',
  'download-again': 'Download again',
};
