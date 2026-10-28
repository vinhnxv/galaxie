// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export type WebLLMUnavailableReason =
  | 'no_webgpu'
  | 'no_adapter'
  | 'no_shader_f16'
  | 'adapter_limits'
  | 'device_lost'
  | 'integrity'
  | 'worker_failed'
  | 'load_failed'
  | 'disposed';
export type WebLLMErrorCode = 'unavailable' | 'invalid' | 'unsupported';

const messages: Record<WebLLMErrorCode, string> = {
  unavailable: 'The WebLLM provider is unavailable.',
  invalid: 'The WebLLM request is invalid.',
  unsupported: 'The WebLLM operation is unsupported.',
};

/** Cross-realm galaxie error shape, without a dependency on core or an engine cause. */
export class WebLLMError extends Error {
  readonly code: WebLLMErrorCode;
  readonly reason?: WebLLMUnavailableReason;

  constructor(code: WebLLMErrorCode, reason?: WebLLMUnavailableReason) {
    super(messages[code]);
    this.name = 'GalaxieError';
    this.code = code;
    if (code === 'unavailable' && reason !== undefined) this.reason = reason;
  }
}

export class WebLLMProviderError extends Error {
  constructor() {
    super('The WebLLM provider failed.');
    this.name = 'WebLLMProviderError';
  }
}
