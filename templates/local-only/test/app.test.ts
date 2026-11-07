// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { ModelError } from '@galaxie/models/builtin-ai';
import type { WebLLMEngineHandle } from '@galaxie/models/webllm';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';
import { modelStates } from '../src/model-state.js';
import {
  createTemplateHost,
  sessionKey,
  type TemplateHost,
  type TemplateHostOptions,
} from '../src/runtime.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement | undefined;
let host: TemplateHost | undefined;

async function unmount(): Promise<void> {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  container = undefined;
  await host?.dispose();
  host = undefined;
}

afterEach(async () => {
  await unmount();
  sessionStorage.removeItem(sessionKey);
  vi.restoreAllMocks();
});

async function shown(check: () => boolean): Promise<void> {
  await expect
    .poll(async () => {
      await act(async () => {});
      return check();
    })
    .toBe(true);
}

async function mount(options: TemplateHostOptions = {}): Promise<TemplateHost> {
  const current = await createTemplateHost({
    builtInAIProbe: async () => {
      throw new ModelError('unavailable', 'no_api');
    },
    webGPUProbe: () => true,
    ...options,
  });
  host = current;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(App, { host: current })));
  await shown(() => container?.querySelector('input[type="radio"]') != null);
  return current;
}

function button(label: string): HTMLButtonElement {
  const found = [...(container?.querySelectorAll('button') ?? [])].find(
    (item) => item.textContent === label,
  );
  if (found === undefined) throw new Error('The requested button is missing.');
  return found;
}

async function completeQuestion(): Promise<void> {
  await act(async () => {
    const radio = container?.querySelector<HTMLInputElement>('input[value="four"]');
    if (radio === null || radio === undefined) throw new Error('The answer is missing.');
    radio.click();
  });
  await act(async () => button('Submit answers').click());
  await shown(
    () =>
      container?.textContent?.includes('Correct. Keep practicing one small step at a time.') ===
      true,
  );
  expect(container?.textContent).toContain('Comment: Mock (In browser)');
}

it('starts and finishes on the mock with both unavailable messages and no WebLLM load', async () => {
  const loader = vi.fn(async () => {
    throw new Error('The loader must not run.');
  });
  const current = await mount({ webGPUProbe: () => false, webLLMLoader: loader });
  expect(current.getModelSnapshot().route).toBe('mock');
  expect(container?.textContent).toContain(modelStates.no_api.message);
  expect(container?.textContent).toContain(modelStates.no_webgpu.message);
  expect(container?.querySelectorAll('section button')).toHaveLength(0);
  await completeQuestion();
  expect(loader).not.toHaveBeenCalled();
});

it('declines the size-disclosed download and keeps a usable mock with Download again', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const loader = vi.fn(async () => {
    throw new Error('The loader must not run.');
  });
  const current = await mount({ webLLMLoader: loader });
  expect(container?.textContent).toContain(modelStates.offer.message);
  await act(async () => button('Download').click());
  expect(confirm).toHaveBeenCalledWith(modelStates.offer.message);
  expect(current.getModelSnapshot()).toMatchObject({ route: 'mock', webllm: 'declined' });
  expect(container?.textContent).toContain(modelStates.declined.message);
  expect(container?.querySelectorAll('section button')).toHaveLength(1);
  expect(button('Download again')).toBeDefined();
  expect(loader).not.toHaveBeenCalled();
  await completeQuestion();
});

it('keeps the mock after download failure and retries without displaying raw errors', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const loader = vi.fn(async () => {
    throw new Error('user-text-canary https://private.invalid/ stack');
  });
  const current = await mount({ webLLMLoader: loader });
  await act(async () => button('Download').click());
  await shown(() => current.getModelSnapshot().webllm === 'failed');
  expect(current.getModelSnapshot().route).toBe('mock');
  expect(container?.textContent).toContain(modelStates.failed.message);
  expect(container?.textContent).not.toContain('user-text-canary');
  expect(container?.querySelectorAll('section button')).toHaveLength(1);
  await act(async () => button('Retry').click());
  await shown(
    () => loader.mock.calls.length === 2 && current.getModelSnapshot().webllm === 'failed',
  );
  await completeQuestion();
});

it('shows bounded progress and Cancel, then returns to a usable offer on cancellation', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  let signal: AbortSignal | undefined;
  const current = await mount({
    webLLMLoader: async (options) => {
      signal = options.signal;
      options.onProgress({ phase: 'download', fraction: 0.4, elapsedSeconds: 1 });
      return new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      });
    },
  });
  await act(async () => button('Download').click());
  expect(container?.textContent).toContain(modelStates.downloading.message);
  expect(container?.querySelector('progress')?.value).toBe(0.4);
  expect(container?.querySelectorAll('section button')).toHaveLength(1);
  await act(async () => button('Cancel').click());
  expect(signal?.aborted).toBe(true);
  expect(current.getModelSnapshot()).toMatchObject({ route: 'mock', webllm: 'offer' });
  expect(container?.textContent).toContain(modelStates.offer.message);
  expect(button('Download')).toBeDefined();
  await completeQuestion();
});

it('selects WebLLM only after a successful opted-in load and removes the control', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const handle = {
    modelId: 'scripted-webllm',
    async *stream() {
      yield {
        choices: [{ delta: { content: 'A local encouraging comment.' }, finish_reason: 'stop' }],
      };
    },
    dispose: vi.fn(async () => {}),
  } as unknown as WebLLMEngineHandle;
  const loader = vi.fn(async () => handle);
  const current = await mount({ webLLMLoader: loader });
  expect(loader).not.toHaveBeenCalled();
  await act(async () => button('Download').click());
  await shown(() => current.getModelSnapshot().webllm === 'ready');
  expect(current.getModelSnapshot().route).toBe('webllm');
  expect(container?.textContent).toContain(modelStates.ready.message);
  expect(container?.querySelectorAll('section button')).toHaveLength(0);
  await act(async () => container?.querySelector<HTMLInputElement>('input[value="four"]')?.click());
  await act(async () => button('Submit answers').click());
  await shown(
    () => container?.textContent?.includes('Correct. A local encouraging comment.') === true,
  );
  expect(container?.textContent).toContain('Comment: WebLLM (In browser)');
});

it('restores the same pending question through reopened real IndexedDB and recovery', async () => {
  await mount({ webGPUProbe: () => false });
  await shown(() => sessionStorage.getItem(sessionKey) !== null);
  const saved = sessionStorage.getItem(sessionKey);
  const question = container?.querySelector('form')?.textContent;
  await unmount();
  // Recreate the entire host and React tree, preserving only browser storage as on reload.
  await mount({ webGPUProbe: () => false });
  expect(sessionStorage.getItem(sessionKey)).toBe(saved);
  expect(container?.querySelector('form')?.textContent).toBe(question);
  expect(container?.querySelector<HTMLInputElement>('input[value="four"]')?.checked).toBe(false);
  await completeQuestion();
  expect(sessionStorage.getItem(sessionKey)).toBeNull();
});
