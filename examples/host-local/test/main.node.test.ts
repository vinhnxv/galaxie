// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import { expect, it, vi } from 'vitest';
import type { LocalHost } from '../src/runtime.js';

it('keeps a cached document alive and disposes resources when it is discarded', async () => {
  const window = new EventTarget();
  const disposeRuntime = vi.fn(async (): Promise<void> => {});
  const disposeEngine = vi.fn(async (): Promise<void> => {});
  const host = { runtime: { dispose: disposeRuntime } } as unknown as LocalHost;
  const render =
    vi.fn<(view: ReactElement<{ prepareModels?: () => Promise<LocalHost> }>) => void>();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', { getElementById: () => ({}) });
  vi.stubGlobal('LanguageModel', undefined);
  vi.doMock('react-dom/client', () => ({ createRoot: () => ({ render }) }));
  vi.doMock('../src/runtime.js', () => ({
    createLocalHost: () => host,
    prepareLocalModels: async () => ({ dispose: disposeEngine }),
    realModels: () => ({}),
  }));
  try {
    await import('../src/main.js');
    const prepare = render.mock.calls[0]?.[0].props.prepareModels;
    if (!prepare) throw new Error('The default preparation action is missing.');
    expect(await prepare()).toBe(host);
    const pagehide = (persisted: boolean): void => {
      const event = new Event('pagehide');
      Object.defineProperty(event, 'persisted', { value: persisted });
      window.dispatchEvent(event);
    };
    pagehide(true);
    await Promise.resolve();
    expect(disposeRuntime).not.toHaveBeenCalled();
    expect(disposeEngine).not.toHaveBeenCalled();
    pagehide(false);
    await expect
      .poll(() => [disposeRuntime.mock.calls.length, disposeEngine.mock.calls.length])
      .toEqual([1, 1]);
  } finally {
    vi.doUnmock('react-dom/client');
    vi.doUnmock('../src/runtime.js');
    vi.unstubAllGlobals();
    vi.resetModules();
  }
  // The first import of the host entry can be slow while the Pyodide suites load the machine.
}, 30_000);
