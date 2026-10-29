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

export function checkPageDevelopmentWarnings(warn: DevelopmentWarningReporter): void {
  try {
    if (typeof document === 'undefined') return;
  } catch {
    return;
  }
  // Enforced policies produce expected console violations (and reports if configured)
  // once per runtime in development. Blocked probes emit no warning. Report-only
  // policies report but allow probes, so they can still warn. A pass-through
  // Trusted Types default createHTML policy is a known false positive.
  try {
    const template = document.createElement('template');
    template.innerHTML = '';
    warn({ code: 'trusted_types_unenforced' });
  } catch {
    // A blocked sink or failed probe provides no evidence of missing enforcement.
  }
  try {
    new Function('return 1');
    warn({ code: 'csp_unenforced', name: 'script-src' });
  } catch {
    // Page code cannot inspect response headers; a failed probe emits no advice.
  }
  const providerKey =
    /(?:^|[^A-Za-z0-9_-])(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{35}|(?:gsk_|hf_|xai-|r8_)[A-Za-z0-9]{20,})/;
  for (const area of ['localStorage', 'sessionStorage'] as const) {
    try {
      const storage = globalThis[area];
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        const value = key === null ? null : storage.getItem(key);
        if (value !== null && providerKey.test(value)) {
          warn({ code: 'provider_key_in_storage', area });
          break;
        }
      }
    } catch {
      // Storage may be denied. Never change it or retain its keys or values.
    }
  }
}
