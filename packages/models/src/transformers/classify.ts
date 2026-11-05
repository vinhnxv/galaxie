// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { ModelError, type ModelUnavailableReason } from '../errors.js';
import type { FailureCode } from './protocol.js';

export interface TransformersFailure {
  readonly code: Exclude<FailureCode, 'provider'>;
  readonly reason?: ModelUnavailableReason;
}

const patterns: readonly (readonly [RegExp, ModelUnavailableReason])[] = [
  [/shader-f16|shaderf16/i, 'no_shader_f16'],
  [/device (?:was |is )?lost|GPUDevice.*lost/i, 'device_lost'],
  [
    /no available backend|webgpu is not (?:supported|available)|webgpu.*not (?:supported|available)/i,
    'no_webgpu',
  ],
  [
    /no (?:compatible )?(?:gpu )?adapter|failed to get gpu adapter|unable to find a compatible gpu/i,
    'no_adapter',
  ],
  [
    /maxBufferSize|maxStorageBufferBindingSize|exceeds the (?:max|limit)|requested limit/i,
    'adapter_limits',
  ],
  [
    /out of memory|allocation failed|array buffer allocation|invalid typed array length/i,
    'load_failed',
  ],
];

/**
 * Maps a runtime failure to a fixed code. Only the returned code and reason cross to the page;
 * the engine's own text never does. An unknown failure is `undefined`, which the Worker reports as
 * a provider failure.
 */
export function classifyTransformersError(error: unknown): TransformersFailure | undefined {
  if (error instanceof ModelError)
    return error.reason === undefined
      ? { code: error.code }
      : { code: error.code, reason: error.reason };
  const text = error instanceof Error ? `${error.name}: ${error.message}` : '';
  if (error instanceof RangeError && /array buffer|typed array|allocation/i.test(text))
    return { code: 'unavailable', reason: 'load_failed' };
  if (/maximum context length|context window/i.test(text)) return { code: 'invalid' };
  for (const [pattern, reason] of patterns)
    if (pattern.test(text)) return { code: 'unavailable', reason };
  return undefined;
}
