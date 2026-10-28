// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';

export interface NetworkRecorder {
  readonly calls: string[];
  selfTest(): Promise<void>;
  reset(): void;
  restore(): void;
}

/** Records outbound APIs without making requests; browser tests may exclude their runner origin. */
export function recordNetwork(allowedOrigin?: string): NetworkRecorder {
  const calls: string[] = [];
  const restore: Array<() => void> = [];
  const probes: Array<() => unknown> = [];
  const record = (kind: string, url?: unknown): void => {
    if (allowedOrigin !== undefined && typeof url === 'string') {
      const destination = new URL(url, allowedOrigin);
      if (destination.host === new URL(allowedOrigin).host) return;
    }
    calls.push(kind);
  };
  if (typeof globalThis.fetch === 'function') {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      record(
        'fetch',
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      return new Response();
    });
    restore.push(() => spy.mockRestore());
    probes.push(() => globalThis.fetch('https://network-probe.invalid/'));
  }
  if (typeof globalThis.XMLHttpRequest !== 'undefined') {
    const spy = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation((_method, url) => {
      record('XMLHttpRequest', String(url));
    });
    restore.push(() => spy.mockRestore());
    probes.push(() => new XMLHttpRequest().open('GET', 'https://network-probe.invalid/'));
  }
  if (typeof globalThis.navigator?.sendBeacon === 'function') {
    const spy = vi.spyOn(navigator, 'sendBeacon').mockImplementation((url) => {
      record('sendBeacon', String(url));
      return true;
    });
    restore.push(() => spy.mockRestore());
    probes.push(() => navigator.sendBeacon('https://network-probe.invalid/'));
  }
  for (const key of ['WebSocket', 'EventSource'] as const) {
    const Original = globalThis[key];
    if (typeof Original !== 'function') continue;
    const replacement = class {
      constructor(url: string | URL) {
        record(key, String(url));
      }
    };
    vi.stubGlobal(key, replacement);
    restore.push(() => {
      vi.stubGlobal(key, Original);
    });
    probes.push(() => {
      const Constructor = globalThis[key];
      return new Constructor('https://network-probe.invalid/');
    });
  }
  return {
    calls,
    async selfTest(): Promise<void> {
      calls.length = 0;
      for (const probe of probes) await probe();
      if (calls.length !== probes.length || new Set(calls).size !== probes.length)
        throw new Error('A network recorder did not fire exactly once.');
      calls.length = 0;
    },
    reset(): void {
      calls.length = 0;
    },
    restore(): void {
      for (const undo of restore.reverse()) undo();
    },
  };
}
