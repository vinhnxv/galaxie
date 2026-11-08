// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { PendingConfirmation } from '@galaxie-ai/core';
import { act, type ReactElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import {
  AgentSurface,
  ConfirmationPrompt,
  createRegistry,
  defineComponent,
  defineConfirmations,
} from '../src/index.js';
import { FakeInstance, interaction } from './support/fake-instance.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const containers: HTMLElement[] = [];
afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

async function mount(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => root.render(element));
  return container;
}

function pending(args: unknown = { lessonId: 'lesson-1' }): PendingConfirmation {
  return Object.freeze({
    id: crypto.randomUUID() as never,
    capability: 'progress.save@1',
    arguments: args,
    expiresAt: Date.now() + 120000,
  });
}

function instance(entry = pending()): FakeInstance {
  const result = new FakeInstance();
  result.setSnapshot({ ...result.getSnapshot(), confirmations: [entry] });
  return result;
}

const confirmations = defineConfirmations({
  'progress.save@1': {
    title: 'Save lesson progress',
    fields: (args) => [{ label: 'Lesson', value: (args as { lessonId: string }).lessonId }],
  },
});

test('host registry text and actual argument rows render, and buttons only respond', async () => {
  const entry = pending();
  const host = instance(entry);
  const container = await mount(
    <ConfirmationPrompt instance={host} confirmations={confirmations} />,
  );
  expect(container.textContent).toBe('Save lesson progressLessonlesson-1AllowCancel');
  const buttons = container.querySelectorAll('button');
  await act(async () => buttons[0]?.click());
  expect(host.respond).toHaveBeenCalledWith(entry.id, 'approve');
  await act(async () => buttons[1]?.click());
  expect(host.respond).toHaveBeenLastCalledWith(entry.id, 'decline');
  expect(host.dispatch).not.toHaveBeenCalled();
});

test('HTML-looking argument values remain React text with no resource elements', async () => {
  const value = '<img src=x onerror=alert(1)>';
  const container = await mount(
    <ConfirmationPrompt
      instance={instance(pending({ lessonId: value }))}
      confirmations={confirmations}
    />,
  );
  expect(container.textContent).toContain(value);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('script')).toBeNull();
});

test.each([
  undefined,
  () => {
    throw new Error('private-host-error-marker');
  },
  () => null,
  () => [{ label: 'Lesson', value: 1 }],
  () => [{ value: 'lesson-1' }],
])('missing, throwing or malformed fields only permit decline: %j', async (fields) => {
  const registry = defineConfirmations(
    fields === undefined
      ? {}
      : {
          'progress.save@1': { title: 'Never shown', fields: fields as never },
        },
  );
  const host = instance();
  const container = await mount(<ConfirmationPrompt instance={host} confirmations={registry} />);
  expect(container.textContent).toBe('This action cannot be shown.Cancel');
  expect(container.querySelectorAll('button')).toHaveLength(1);
  await act(async () => container.querySelector('button')?.click());
  expect(host.respond).toHaveBeenCalledExactlyOnceWith(
    host.getSnapshot().confirmations?.[0]?.id,
    'decline',
  );
});

test('custom button labels come from a frozen host entry', async () => {
  const entry = {
    title: 'Save',
    fields: () => [],
    approveLabel: 'Save now',
    declineLabel: 'Keep editing',
  };
  const registry = defineConfirmations({ 'progress.save@1': entry });
  entry.title = 'Changed';
  expect(registry.capabilities).toEqual(['progress.save@1']);
  expect(Object.isFrozen(registry.capabilities)).toBe(true);
  expect(Object.isFrozen(registry.entry('progress.save@1'))).toBe(true);
  expect(registry.entry('missing@1')).toBeUndefined();
  const container = await mount(
    <ConfirmationPrompt instance={instance()} confirmations={registry} />,
  );
  expect(container.textContent).toBe('SaveSave nowKeep editing');
});

test.each([
  null,
  [],
  { 'progress.save@1': null },
  { 'progress.save@1': { title: 1, fields: () => [] } },
  { 'progress.save@1': { title: 'Save' } },
  { 'progress.save@1': { title: 'Save', fields: () => [], approveLabel: 1 } },
  { 'progress.save@1': { title: 'Save', fields: () => [], declineLabel: null } },
])('invalid registry definitions throw fixed invalid errors: %j', (entries) => {
  let error: unknown;
  try {
    defineConfirmations(entries as never);
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ code: 'invalid', message: 'The request is invalid.' });
  expect(error).not.toHaveProperty('cause');
});

test('an agent action named approve dispatches only its interaction', async () => {
  const host = instance();
  host.setPending(interaction());
  const entry = pending();
  host.setSnapshot({ ...host.getSnapshot(), confirmations: [entry] });
  let received: unknown;
  const registry = createRegistry({
    components: [
      defineComponent({
        id: 'tests.Question/v1',
        props: z.object({ title: z.string() }),
        actions: { approve: { label: 'Agent look-alike', payload: z.object({}) } },
        component: (input): ReactElement => {
          received = input;
          return (
            <button type="button" onClick={() => void input.actions.approve.submit({})}>
              {input.actions.approve.label}
            </button>
          );
        },
      }),
    ],
  });
  const container = await mount(
    <>
      <AgentSurface instance={host} registry={registry} surfaceId="lesson-main" />
      <ConfirmationPrompt instance={host} confirmations={confirmations} />
    </>,
  );
  await act(async () => container.querySelector('button')?.click());
  expect(host.dispatch).toHaveBeenCalledTimes(1);
  expect(host.dispatch.mock.calls[0]?.[0].action).toBe('approve');
  expect(host.respond).not.toHaveBeenCalled();
  expect(Object.keys(received as object).sort()).toEqual(['actions', 'props', 'status']);
  expect(JSON.stringify(received)).not.toContain(entry.id);
});

test('Strict Mode tracks pending changes without owning lifecycle or responding during render', async () => {
  const host = instance();
  const container = await mount(
    <StrictMode>
      <ConfirmationPrompt instance={host} confirmations={confirmations} />
    </StrictMode>,
  );
  expect(host.subscriberCount).toBe(1);
  expect(container.querySelectorAll('button')).toHaveLength(2);
  expect(host.respond).not.toHaveBeenCalled();
  await act(async () => host.setSnapshot({ instanceId: host.instanceId, state: 'ready' }));
  expect(container.textContent).toBe('');
  expect(host.prepare).not.toHaveBeenCalled();
  expect(host.dispose).not.toHaveBeenCalled();
});
