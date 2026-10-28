// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { WebLLMUnavailableReason } from '../errors.js';

export type WebLLMFailure =
  | { readonly code: 'unavailable'; readonly reason: WebLLMUnavailableReason }
  | { readonly code: 'invalid' };

/** Engine rejections cross the worker as strings. Return only allowlisted classifications. */
export function classifyWebLLMError(error: unknown): WebLLMFailure | undefined {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const name =
    error instanceof Error && error.name !== 'Error' ? error.name : text.split(':', 1)[0];
  const reasons: Readonly<Record<string, WebLLMUnavailableReason>> = {
    WebGPUNotAvailableError: 'no_webgpu',
    ShaderF16SupportError: 'no_shader_f16',
    FeatureSupportError: 'no_shader_f16',
    DeviceLostError: 'device_lost',
    IntegrityError: 'integrity',
    ModelNotLoadedError: 'device_lost',
    WorkerEngineModelNotLoadedError: 'device_lost',
  };
  if (name === 'ContextWindowSizeExceededError') return { code: 'invalid' };
  if (name !== undefined && Object.hasOwn(reasons, name))
    return { code: 'unavailable', reason: reasons[name] as WebLLMUnavailableReason };
  const message = text.replace(/^Error: /, '');
  if (message.startsWith('Unable to find a compatible GPU'))
    return { code: 'unavailable', reason: 'no_adapter' };
  if (message.startsWith('Cannot initialize runtime because of requested'))
    return { code: 'unavailable', reason: 'adapter_limits' };
  return undefined;
}
