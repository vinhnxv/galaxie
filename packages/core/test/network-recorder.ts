// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';

export interface NetworkRecorder {
  readonly calls: string[];
  selfTest(): Promise<void>;
  reset(): void;
  restore(): void;
}

/** Records and blocks outbound APIs; allowed browser runner-origin calls pass through. */
export function recordNetwork(allowedOrigin?: string): NetworkRecorder {
  const calls: string[] = [];
  const restore: Array<() => void> = [];
  const probes: Array<() => unknown> = [];
  const isAllowed = (url: unknown): boolean => {
    if (allowedOrigin === undefined || typeof url !== 'string') return false;
    const origin = new URL(allowedOrigin);
    const destination = new URL(url, origin);
    return (
      destination.host === origin.host &&
      (destination.protocol === origin.protocol ||
        destination.protocol === origin.protocol.replace('http', 'ws'))
    );
  };
  const record = (kind: string, url?: unknown): void => {
    if (isAllowed(url)) return;
    calls.push(kind);
  };
  if (typeof globalThis.fetch === 'function') {
    const original = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (isAllowed(url)) return original(input, init);
      record('fetch', url);
      return new Response();
    });
    restore.push(() => spy.mockRestore());
    probes.push(() => globalThis.fetch('https://network-probe.invalid/'));
  }
  if (typeof globalThis.XMLHttpRequest !== 'undefined') {
    const original = XMLHttpRequest.prototype.open;
    const spy = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(function (
      this: XMLHttpRequest,
      method,
      url,
      async = true,
      username,
      password,
    ) {
      if (isAllowed(String(url)))
        return original.call(this, method, url, async, username, password);
      record('XMLHttpRequest', String(url));
    });
    restore.push(() => spy.mockRestore());
    probes.push(() => new XMLHttpRequest().open('GET', 'https://network-probe.invalid/'));
  }
  if (typeof globalThis.navigator?.sendBeacon === 'function') {
    const original = navigator.sendBeacon.bind(navigator);
    const spy = vi.spyOn(navigator, 'sendBeacon').mockImplementation((url, data) => {
      if (isAllowed(String(url))) return original(url, data);
      record('sendBeacon', String(url));
      return true;
    });
    restore.push(() => spy.mockRestore());
    probes.push(() => navigator.sendBeacon('https://network-probe.invalid/'));
  }
  for (const key of ['WebSocket', 'EventSource'] as const) {
    const Original = globalThis[key];
    if (typeof Original !== 'function') continue;
    const replacement = new Proxy(Original, {
      construct(target, args, newTarget) {
        const url = String(args[0]);
        if (isAllowed(url)) return Reflect.construct(target, args, newTarget);
        record(key, url);
        return {};
      },
    });
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
      if (calls.length !== 0)
        throw new Error('Network requests were observed before recorder self-test.');
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
