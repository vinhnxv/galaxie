// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { vi } from 'vitest';

export interface InjectionRequest {
  readonly kind: string;
  readonly url: string;
  body: string;
}
export interface InjectionNetwork {
  readonly requests: InjectionRequest[];
  settle(): Promise<void>;
  restore(): void;
}

/** Records bodies even for allowed requests, and blocks other origins before dispatch. */
export function recordInjectionNetwork(origins: readonly string[]): InjectionNetwork {
  const requests: InjectionRequest[] = [];
  const pending: Promise<void>[] = [];
  const undo: Array<() => void> = [];
  const base = origins[0];
  const allowed = new Set(origins);
  const absolute = (url: string): string => new URL(url, base).href;
  const permits = (url: string): boolean => {
    const destination = new URL(url, base);
    if (destination.protocol === 'ws:') destination.protocol = 'http:';
    if (destination.protocol === 'wss:') destination.protocol = 'https:';
    return allowed.has(destination.origin);
  };
  const record = (kind: string, url: string, body?: unknown): void => {
    const entry: InjectionRequest = { kind, url: absolute(url), body: '' };
    requests.push(entry);
    if (body instanceof Blob || body instanceof Request) {
      pending.push(
        body.text().then((text) => {
          entry.body = text;
        }),
      );
    } else if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      const bytes =
        body instanceof ArrayBuffer
          ? new Uint8Array(body)
          : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      entry.body = new TextDecoder().decode(bytes);
    } else if (body instanceof FormData) {
      pending.push(
        Promise.all(
          [...body.entries()].map(async ([name, value]) => [
            name,
            typeof value === 'string' ? value : await value.text(),
          ]),
        ).then((values) => {
          entry.body = JSON.stringify(values);
        }),
      );
    } else if (body !== undefined && body !== null) entry.body = String(body);
  };
  const originalFetch = globalThis.fetch;
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    record('fetch', url, new Request(input, init).clone());
    if (!permits(url)) throw new Error('Corpus recorder blocked an outbound request.');
    return originalFetch(input, init);
  });
  undo.push(() => fetchSpy.mockRestore());

  if (typeof XMLHttpRequest !== 'undefined') {
    const urls = new WeakMap<XMLHttpRequest, string>();
    const open = XMLHttpRequest.prototype.open;
    const send = XMLHttpRequest.prototype.send;
    const openSpy = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(function (
      this: XMLHttpRequest,
      method,
      url,
      async = true,
      username,
      password,
    ) {
      urls.set(this, String(url));
      if (permits(String(url))) open.call(this, method, url, async, username, password);
    });
    const sendSpy = vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(function (
      this: XMLHttpRequest,
      body,
    ) {
      const url = urls.get(this);
      if (url === undefined) throw new Error('Corpus recorder requires an opened request.');
      record('XMLHttpRequest', url, body);
      if (permits(url)) send.call(this, body);
    });
    undo.push(() => {
      sendSpy.mockRestore();
      openSpy.mockRestore();
    });
  }
  if (typeof globalThis.navigator?.sendBeacon === 'function') {
    const beacon = navigator.sendBeacon.bind(navigator);
    const spy = vi.spyOn(navigator, 'sendBeacon').mockImplementation((url, body) => {
      record('sendBeacon', String(url), body);
      return permits(String(url)) ? beacon(url, body) : false;
    });
    undo.push(() => spy.mockRestore());
  }
  for (const key of ['WebSocket', 'EventSource'] as const) {
    const Original = globalThis[key];
    if (typeof Original !== 'function') continue;
    const replacement = new Proxy(Original, {
      construct(target, args, newTarget) {
        const url = String(args[0]);
        record(key, url);
        if (!permits(url))
          return { send: (body: unknown) => record(key, url, body), close: () => {} };
        const instance = Reflect.construct(target, args, newTarget);
        if (key === 'WebSocket') {
          const send = instance.send.bind(instance);
          instance.send = (body: unknown): void => {
            record(key, url, body);
            send(body);
          };
        }
        return instance;
      },
    });
    Object.defineProperty(globalThis, key, {
      ...Object.getOwnPropertyDescriptor(globalThis, key),
      value: replacement,
    });
    undo.push(() => {
      Object.defineProperty(globalThis, key, {
        ...Object.getOwnPropertyDescriptor(globalThis, key),
        value: Original,
      });
    });
  }
  return {
    requests,
    async settle(): Promise<void> {
      await Promise.all(pending);
    },
    restore(): void {
      for (const restore of undo.reverse()) restore();
    },
  };
}
