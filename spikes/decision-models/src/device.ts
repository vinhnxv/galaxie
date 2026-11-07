// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Minimal GPU and browser declarations adapted from spikes/b-local-inference/src/device.ts.
import type { Profile } from './results.js';

interface Adapter {
  info?: { vendor?: string; architecture?: string; device?: string; description?: string };
  limits: object;
}
export async function deviceProfile(): Promise<Profile> {
  const nav = navigator as unknown as {
    gpu?: { requestAdapter(): Promise<Adapter | null> };
    deviceMemory?: number;
    userAgentData?: {
      getHighEntropyValues(
        hints: string[],
      ): Promise<{ fullVersionList?: { brand: string; version: string }[] }>;
    };
  };
  let adapter: Adapter | null = null;
  try {
    adapter = (await nav.gpu?.requestAdapter()) ?? null;
  } catch {}
  let browserVersion = /(?:Chrome|Chromium)\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? null;
  try {
    const versions = (await nav.userAgentData?.getHighEntropyValues(['fullVersionList']))
      ?.fullVersionList;
    browserVersion =
      versions?.find((entry) => ['Google Chrome', 'Chromium'].includes(entry.brand))?.version ??
      browserVersion;
  } catch {}
  const limits: Record<string, number> = {};
  if (adapter) {
    const names = new Set([
      ...Object.keys(adapter.limits),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(adapter.limits) as object),
    ]);
    for (const name of names) {
      const value: unknown = Reflect.get(adapter.limits, name);
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) limits[name] = value;
    }
  }
  return {
    userAgent: navigator.userAgent,
    browserVersion,
    deviceMemoryGiB: nav.deviceMemory ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? 0,
    pageVersion: '1',
    ortVersion: '1.31.0-dev.20260914-8d85527a0',
    webgpu: {
      present: Boolean(nav.gpu),
      adapter: adapter
        ? {
            vendor: adapter.info?.vendor ?? '',
            architecture: adapter.info?.architecture ?? '',
            device: adapter.info?.device ?? '',
            description: adapter.info?.description ?? '',
          }
        : null,
      limits,
    },
  };
}
