// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export type ModelUnavailableReason =
  | 'no_webgpu'
  | 'no_adapter'
  | 'no_shader_f16'
  | 'adapter_limits'
  | 'device_lost'
  | 'integrity'
  | 'worker_failed'
  | 'load_failed'
  | 'disposed'
  | 'no_api'
  | 'unsupported_languages'
  | 'download_required'
  | 'activation_required'
  | 'download_failed'
  | 'not_allowed'
  | 'rate_limited'
  | 'endpoint_failed'
  | 'network';
export type ModelErrorCode = 'unavailable' | 'unreachable' | 'invalid' | 'unsupported';

const messages: Record<ModelErrorCode, string> = {
  unavailable: 'The model provider is unavailable.',
  unreachable:
    'The endpoint did not answer. Local Network Access may be denied, CORS may not allow this app origin (for example OLLAMA_ORIGINS), or the server may be stopped.',
  invalid: 'The model request is invalid.',
  unsupported: 'The model operation is unsupported.',
};

/** Cross-realm galaxie error shape, without a dependency on core or an engine cause. */
export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly reason?: ModelUnavailableReason;

  constructor(code: ModelErrorCode, reason?: ModelUnavailableReason) {
    super(messages[code]);
    this.name = 'GalaxieError';
    this.code = code;
    if (code === 'unavailable' && reason !== undefined) this.reason = reason;
  }
}

export class ModelProviderError extends Error {
  constructor() {
    super('The model provider failed.');
    this.name = 'ModelProviderError';
  }
}
