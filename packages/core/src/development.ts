// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { InstanceId } from './ids.js';

export type DevelopmentWarningCode =
  | 'csp_unenforced'
  | 'trusted_types_unenforced'
  | 'capability_unbound'
  | 'role_without_provider'
  | 'provider_key_in_storage'
  | 'url_blocked';

/** Best-effort advice containing only codes and trusted definition/host identifiers. */
export interface DevelopmentWarning {
  readonly code: DevelopmentWarningCode;
  readonly instanceId?: InstanceId;
  readonly name?: string;
  readonly area?: 'localStorage' | 'sessionStorage';
}

export type DevelopmentWarningReporter = (
  warning: DevelopmentWarning,
  onError?: (error: unknown) => void,
) => void;

/** Internal runtime-wide de-duplication, including callbacks that throw. */
export function createDevelopmentWarnings(
  callback: (warning: DevelopmentWarning) => void,
): DevelopmentWarningReporter {
  const emitted = new Set<string>();
  return (warning, onError) => {
    const key = JSON.stringify([warning.code, warning.instanceId, warning.name, warning.area]);
    if (emitted.has(key)) return;
    emitted.add(key);
    try {
      callback(Object.freeze(warning));
    } catch (error) {
      if (onError !== undefined) onError(error);
      else
        queueMicrotask(() => {
          throw error;
        });
    }
  };
}
