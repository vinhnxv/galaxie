// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import workerUrl from './webllm-worker.ts?worker&url';

interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
}

let installed = false;

/** This policy grants only the bundled worker URL; HTML and other scripts have no rule. */
export function allowWorkerScript(): void {
  if (installed) return;
  const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypesFactory })
    .trustedTypes;
  if (!factory) return;
  const allowed = new URL(workerUrl, globalThis.location.href);
  factory.createPolicy('default', {
    createScriptURL(value) {
      const candidate = new URL(value, globalThis.location.href);
      if (candidate.origin !== globalThis.location.origin || candidate.href !== allowed.href)
        throw new TypeError('The worker script URL is not allowed.');
      return candidate.href;
    },
  });
  installed = true;
}
