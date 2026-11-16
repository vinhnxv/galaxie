// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

interface TrustedTypesFactory {
  createPolicy(name: string, rules: { createScriptURL(value: string): string }): unknown;
}

const allowed = new Set<string>();
let installed = false;

/** Only host-selected, same-origin bundled worker URLs enter the default policy. */
export function installWorkerPolicy(url: string): void {
  const worker = new URL(url, location.href);
  if (worker.origin !== location.origin)
    throw new TypeError('The worker script URL is not allowed.');
  allowed.add(worker.href);
  const factory = (globalThis as typeof globalThis & { trustedTypes?: TrustedTypesFactory })
    .trustedTypes;
  if (factory === undefined || installed) return;
  factory.createPolicy('default', {
    createScriptURL(value) {
      const candidate = new URL(value, location.href);
      if (!allowed.has(candidate.href))
        throw new TypeError('The worker script URL is not allowed.');
      return candidate.href;
    },
  });
  installed = true;
}

export function createWorker(url: string): Worker {
  installWorkerPolicy(url);
  return new Worker(new URL(url, location.href), { type: 'module' });
}
