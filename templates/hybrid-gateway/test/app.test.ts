// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { App, GatewayStatus } from '../src/app.js';
import { gatewayStateForStatus, gatewayStates } from '../src/gateway-state.js';
import { createHybridHost, type HybridHost } from '../src/runtime.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let host: HybridHost | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  await host?.dispose();
  host = undefined;
});

function mount(): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
}

it.each([200, 401, 403, 429, 503])(
  'renders exactly the fixed status and one control or none for HTTP %s',
  async (status) => {
    mount();
    let retried = 0;
    const state = gatewayStateForStatus(status);
    await act(async () =>
      root?.render(
        createElement(GatewayStatus, {
          state,
          retry: () => {
            retried++;
          },
        }),
      ),
    );
    expect(container?.querySelector('[role="status"]')?.textContent).toBe(
      gatewayStates[state].message,
    );
    const buttons = container?.querySelectorAll('button');
    expect(buttons?.length).toBe(status === 200 ? 0 : 1);
    if (status !== 200) {
      expect(buttons?.[0]?.textContent).toBe('Retry');
      await act(async () => buttons?.[0]?.click());
      expect(retried).toBe(1);
    }
  },
);

it.each([401, 429, 503])(
  'maps an actual failing model response %s without raw text and Retry opens a new question',
  async (status) => {
    mount();
    let modelCalls = 0;
    host = createHybridHost({
      baseURL: location.origin,
      fetch: async (input) => {
        if (new URL(String(input)).pathname === '/api/session') {
          return Response.json({ token: crypto.randomUUID(), expiresAt: Date.now() + 300_000 });
        }
        modelCalls++;
        return Response.json(
          { error: 'raw-error-canary https://private.invalid/ token stack' },
          {
            status,
          },
        );
      },
    });
    await act(async () => root?.render(createElement(App, { host: host as HybridHost })));
    expect(modelCalls).toBe(0);
    await act(async () => container?.querySelector<HTMLButtonElement>('button')?.click());
    await expect
      .poll(async () => {
        await act(async () => {});
        return container?.querySelector('input[value="four"]') != null;
      })
      .toBe(true);
    await act(async () =>
      container?.querySelector<HTMLInputElement>('input[value="four"]')?.click(),
    );
    const submit = [...(container?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent === 'Submit answers',
    );
    await act(async () => submit?.click());
    await expect
      .poll(async () => {
        await act(async () => {});
        return container?.textContent?.includes(
          gatewayStates[gatewayStateForStatus(status)].message,
        );
      })
      .toBe(true);
    expect(container?.textContent).not.toMatch(/raw-error-canary|private\.invalid|token stack/);
    expect(modelCalls).toBe(1);
    const retry = container?.querySelector<HTMLButtonElement>(
      'section[aria-label="Gateway status"] button',
    );
    expect(retry?.textContent).toBe('Retry');
    await act(async () => retry?.click());
    await expect
      .poll(async () => {
        await act(async () => {});
        return container?.querySelector('input[value="four"]') != null;
      })
      .toBe(true);
    expect(host.getGatewayState()).toBe('ready');
  },
);
