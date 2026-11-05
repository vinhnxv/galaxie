// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { isStoredFile } from './model-files.js';
import {
  modelCacheName,
  modelFileUrl,
  parseModelRecord,
  type TransformersModelRecord,
  totalBytes,
} from './model-record.js';

export interface CheckTransformersModelOptions {
  readonly model: TransformersModelRecord;
}

export type TransformersModelAvailability =
  | { readonly status: 'available' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'downloadable'; readonly bytes: number; readonly siteStorage: true };

/**
 * Reports whether every file of the record was verified and stored earlier. It compares the size
 * markers written at store time, so it hashes nothing and fetches nothing; the load re-verifies.
 * `available` therefore means stored files exist, never that an engine is loaded (ADR-0021).
 */
export async function checkTransformersModel(
  options: CheckTransformersModelOptions,
): Promise<TransformersModelAvailability> {
  const model = parseModelRecord(options.model);
  const navigator = globalThis.navigator as (Navigator & { readonly gpu?: unknown }) | undefined;
  if (model.device === 'webgpu' && navigator?.gpu === undefined) return { status: 'unavailable' };
  if (typeof caches === 'undefined') return { status: 'unavailable' };
  const downloadable = {
    status: 'downloadable',
    bytes: totalBytes(model),
    siteStorage: true,
  } as const;
  try {
    const name = modelCacheName(model);
    // Opening a missing cache would create it, so an unknown cache is answered without opening.
    if (!(await caches.has(name))) return downloadable;
    const cache = await caches.open(name);
    for (const file of model.files) {
      const stored = await cache.match(modelFileUrl(model, file));
      if (stored === undefined || !isStoredFile(stored, file)) return downloadable;
    }
    return { status: 'available' };
  } catch {
    return { status: 'unavailable' };
  }
}
