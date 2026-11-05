// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { AgentSnapshot } from '@galaxie/core';
import { act, type ReactElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test } from 'vitest';
import { ModelRoutes } from '../src/index.js';
import { FakeInstance } from './support/fake-instance.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
const containers: HTMLElement[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

async function mount(element: ReactElement): Promise<{ root: Root; container: HTMLElement }> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => root.render(element));
  return { root, container };
}

function routes(
  instance: FakeInstance,
  selected: NonNullable<AgentSnapshot<unknown>['routes']>,
): void {
  instance.setSnapshot({ ...instance.getSnapshot(), routes: selected });
}

test('shows two roles in snapshot order with trusted host labels and a polite live region', async () => {
  const instance = new FakeInstance();
  routes(instance, {
    'tutor.quiz': { providerId: 'remote', destination: 'host-server' },
    'tutor.feedback': { providerId: 'local', destination: 'in-browser' },
  });
  const { container } = await mount(
    <ModelRoutes
      instance={instance}
      labels={{
        roles: { 'tutor.quiz': 'Quiz', 'tutor.feedback': 'Feedback' },
        providers: { remote: 'Lesson service', local: 'Browser model' },
      }}
    />,
  );
  expect([...container.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
    'Quiz: Lesson service (Host server)',
    'Feedback: Browser model (In browser)',
  ]);
  expect(container.querySelector('ul')?.getAttribute('aria-label')).toBe('Model destinations');
  expect(
    container.querySelector('[aria-live="polite"]')?.contains(container.querySelector('ul')),
  ).toBe(true);
  expect(container.querySelector('[role="status"]')).toBeNull();
});

test('falls back to raw IDs and renders identifiers and host labels only as React text', async () => {
  const instance = new FakeInstance();
  routes(instance, {
    '<b>role</b>': { providerId: '<img src=x>', destination: 'user-device' },
    labeled: { providerId: 'named', destination: 'user-endpoint' },
  });
  const { container } = await mount(
    <ModelRoutes
      instance={instance}
      labels={{ roles: { labeled: '<b>Role</b>' }, providers: { named: '<i>Provider</i>' } }}
    />,
  );
  expect([...container.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
    '<b>role</b>: <img src=x> (User device)',
    '<b>Role</b>: <i>Provider</i> (User endpoint)',
  ]);
  expect(container.querySelector('b, img, i')).toBeNull();
});

test.each(['toString', 'constructor', '__proto__'])(
  'falls back to raw %s IDs when label maps have no own entry',
  async (id) => {
    const instance = new FakeInstance();
    routes(instance, { [id]: { providerId: id, destination: 'in-browser' } });
    const { container } = await mount(
      <ModelRoutes instance={instance} labels={{ roles: {}, providers: {} }} />,
    );
    expect(container.querySelector('li')?.textContent).toBe(`${id}: ${id} (In browser)`);
  },
);

test('shows destination changes and uses destination label overrides for both classes', async () => {
  const instance = new FakeInstance();
  routes(instance, {
    quiz: { providerId: 'remote', destination: 'third-party', changedFrom: 'in-browser' },
  });
  const { root, container } = await mount(<ModelRoutes instance={instance} />);
  expect(container.querySelector('li')?.textContent).toBe(
    'quiz: remote (Third party) changed from In browser',
  );
  await act(async () =>
    root.render(
      <ModelRoutes
        instance={instance}
        destinationLabels={{ 'third-party': '<b>External</b>', 'in-browser': 'On device' }}
      />,
    ),
  );
  expect(container.querySelector('li')?.textContent).toBe(
    'quiz: remote (<b>External</b>) changed from On device',
  );
  expect(container.querySelector('b')).toBeNull();
});

test('keeps the live container mounted before selection and when routes become empty', async () => {
  const instance = new FakeInstance();
  const { container } = await mount(<ModelRoutes instance={instance} />);
  const live = container.querySelector('[aria-live="polite"]');
  expect(live).not.toBeNull();
  expect(container.querySelector('ul, li')).toBeNull();
  await act(async () =>
    routes(instance, { quiz: { providerId: 'local', destination: 'in-browser' } }),
  );
  expect(container.querySelector('[aria-live="polite"]')).toBe(live);
  expect(container.querySelector('li')?.textContent).toBe('quiz: local (In browser)');
  await act(async () => routes(instance, {}));
  expect(container.querySelector('[aria-live="polite"]')).toBe(live);
  expect(container.querySelector('ul, li')).toBeNull();
});

test('updates selections and switches subscriptions in Strict Mode without owning lifecycle', async () => {
  const instance = new FakeInstance();
  const other = new FakeInstance('instance-2');
  const view = (current: FakeInstance): ReactElement => (
    <StrictMode>
      <ModelRoutes instance={current} />
    </StrictMode>
  );
  const { root, container } = await mount(view(instance));
  expect(instance.subscriberCount).toBe(1);
  await act(async () =>
    routes(instance, { quiz: { providerId: 'local', destination: 'in-browser' } }),
  );
  await act(async () =>
    routes(instance, {
      quiz: { providerId: 'remote', destination: 'host-server', changedFrom: 'in-browser' },
    }),
  );
  expect(container.querySelector('li')?.textContent).toBe(
    'quiz: remote (Host server) changed from In browser',
  );
  await act(async () => root.render(view(other)));
  expect(instance.subscriberCount).toBe(0);
  expect(other.subscriberCount).toBe(1);
  expect(container.querySelector('li')).toBeNull();
  await act(async () => root.unmount());
  roots.splice(roots.indexOf(root), 1);
  expect(other.subscriberCount).toBe(0);
  for (const current of [instance, other]) {
    expect(current.prepare).not.toHaveBeenCalled();
    expect(current.start).not.toHaveBeenCalled();
    expect(current.dispose).not.toHaveBeenCalled();
  }
});
