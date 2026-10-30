// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type DispatchReceipt, type ErrorCode, toErrorInfo } from '@galaxie/core';
import {
  AgentSurface,
  createRegistry,
  educationComponents,
  type InteractionStatus,
  Quiz,
  WritingPrompt,
} from '@galaxie/react';
import { act, type ReactElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { FakeInstance, interaction } from '../../packages/react/test/support/fake-instance.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
const containers: HTMLElement[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  for (const container of containers.splice(0)) container.remove();
});

async function mount(element: ReactElement) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => root.render(element));
  return { root, container, view: page.elementLocator(container) };
}

const quizProps = {
  title: 'Quiz model-text-canary',
  questions: [
    {
      id: 'q1',
      prompt: 'First question',
      options: [
        { id: 'a', label: 'First answer' },
        { id: 'b', label: 'Second answer' },
      ],
    },
    {
      id: 'q2',
      prompt: 'Second question',
      options: [
        { id: 'a', label: 'Third answer' },
        { id: 'b', label: 'Fourth answer' },
      ],
    },
  ],
};

const writingProps = { prompt: 'Write a sentence model-text-canary' };
const components = ['Quiz', 'WritingPrompt'] as const;
type EducationComponent = (typeof components)[number];

function renderStatus(component: EducationComponent, status: InteractionStatus): ReactElement {
  const submit = vi.fn(
    async (): Promise<DispatchReceipt> => ({
      status: 'rejected',
      error: toErrorInfo('invalid'),
    }),
  );
  return component === 'Quiz' ? (
    <Quiz.component
      props={quizProps}
      actions={{ submit: { label: Quiz.actions.submit.label, submit } }}
      status={status}
    />
  ) : (
    <WritingPrompt.component
      props={writingProps}
      actions={{ submit: { label: WritingPrompt.actions.submit.label, submit } }}
      status={status}
    />
  );
}

const rejectedMessages: readonly (readonly [ErrorCode, string])[] = [
  ['invalid', 'Check your answer and try again.'],
  ['duplicate', 'This answer was already sent.'],
  ['stale', 'This question is no longer active.'],
  ['denied', 'Your answer could not be sent. Try again.'],
  ['unavailable', 'Your answer could not be sent. Try again.'],
  ['unreachable', 'Your answer could not be sent. Try again.'],
  ['unsupported', 'Your answer could not be sent. Try again.'],
  ['budget_exceeded', 'Your answer could not be sent. Try again.'],
  ['timeout', 'Your answer could not be sent. Try again.'],
  ['fenced', 'Your answer could not be sent. Try again.'],
  ['cancelled', 'Your answer could not be sent. Try again.'],
  ['unrecoverable', 'Your answer could not be sent. Try again.'],
  ['outcome_unknown', 'Your answer could not be sent. Try again.'],
  ['executor_error', 'Your answer could not be sent. Try again.'],
];

for (const component of components) {
  test.each(rejectedMessages)(`${component} shows a fixed alert for %s`, async (code, message) => {
    const focused = document.activeElement;
    const { container, view } = await mount(
      <StrictMode>{renderStatus(component, { rejected: code })}</StrictMode>,
    );
    const alert = view.getByRole('alert').element();
    expect(alert.textContent).toBe(message);
    expect(alert.textContent).not.toContain('model-text-canary');
    expect(container.querySelector('button')?.getAttribute('aria-describedby')).toBe(alert.id);
    expect(alert.id).not.toBe('');
    expect(document.activeElement).toBe(focused);
  });

  test.each(['idle', 'submitting', 'accepted'] as const)(
    `${component} clears the alert on %s and focuses only when entering rejection`,
    async (status) => {
      const { root, container, view } = await mount(
        <StrictMode>{renderStatus(component, 'idle')}</StrictMode>,
      );
      await act(async () =>
        root.render(<StrictMode>{renderStatus(component, { rejected: 'invalid' })}</StrictMode>),
      );
      expect(document.activeElement).toBe(view.getByRole('alert').element());
      const input = container.querySelector('input, textarea');
      if (!(input instanceof HTMLElement)) throw new Error('The answer input is missing.');
      input.focus();
      await act(async () =>
        root.render(<StrictMode>{renderStatus(component, { rejected: 'stale' })}</StrictMode>),
      );
      expect(document.activeElement).toBe(input);
      expect(view.getByRole('alert').element().textContent).toBe(
        'This question is no longer active.',
      );
      await act(async () =>
        root.render(<StrictMode>{renderStatus(component, status)}</StrictMode>),
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector('button')?.hasAttribute('aria-describedby')).toBe(false);
      await act(async () =>
        root.render(<StrictMode>{renderStatus(component, { rejected: 'invalid' })}</StrictMode>),
      );
      expect(document.activeElement).toBe(view.getByRole('alert').element());
    },
  );
}

test.each(components)('%s supports keyboard completion, rejection and retry', async (component) => {
  const instance = new FakeInstance();
  instance.setPending(
    interaction({
      component: component === 'Quiz' ? Quiz.id : WritingPrompt.id,
      props: component === 'Quiz' ? quizProps : writingProps,
    }),
  );
  const first = Promise.withResolvers<DispatchReceipt>();
  const retry = Promise.withResolvers<DispatchReceipt>();
  instance.dispatch.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  const { container, view } = await mount(
    <StrictMode>
      <button type="button">Before lesson</button>
      <AgentSurface
        instance={instance}
        registry={createRegistry({ components: educationComponents })}
        surfaceId="lesson-main"
      />
      <button type="button">After lesson</button>
    </StrictMode>,
  );
  const before = view.getByRole('button', { name: 'Before lesson' }).element();
  const after = view.getByRole('button', { name: 'After lesson' }).element();
  const submit = view
    .getByRole('button', {
      name: component === 'Quiz' ? 'Submit answers' : 'Submit sentence',
      exact: true,
    })
    .element();
  before.focus();
  await act(async () => userEvent.keyboard('{Tab}'));
  if (component === 'Quiz') {
    const firstGroup = view.getByRole('group', { name: 'First question', exact: true });
    const secondGroup = view.getByRole('group', { name: 'Second question', exact: true });
    expect(document.activeElement).toBe(
      firstGroup.getByRole('radio', { name: 'First answer', exact: true }).element(),
    );
    await act(async () => userEvent.keyboard('{ArrowRight}{Tab} '));
    expect(document.activeElement).toBe(
      secondGroup.getByRole('radio', { name: 'Third answer', exact: true }).element(),
    );
  } else {
    expect(document.activeElement).toBe(
      view.getByRole('textbox', { name: writingProps.prompt, exact: true }).element(),
    );
    await act(async () => userEvent.keyboard('  Private draft-canary.  '));
  }
  await act(async () => userEvent.keyboard('{Tab}'));
  expect(document.activeElement).toBe(submit);
  await act(async () => userEvent.keyboard('{Enter}'));
  expect(instance.dispatch).toHaveBeenCalledTimes(1);
  const payload =
    component === 'Quiz'
      ? { answers: { q1: 'b', q2: 'a' } }
      : { sentence: 'Private draft-canary.' };
  expect(instance.dispatch.mock.calls[0]?.[0].payload).toEqual(payload);
  expect(submit.matches(':disabled')).toBe(true);
  for (const input of container.querySelectorAll('input, textarea'))
    expect(input.matches(':disabled')).toBe(true);
  before.focus();
  await act(async () => userEvent.keyboard('{Tab}'));
  expect(document.activeElement).toBe(after);
  await act(async () => first.resolve({ status: 'rejected', error: toErrorInfo('invalid') }));
  const alert = view.getByRole('alert').element();
  expect(alert.textContent).toBe('Check your answer and try again.');
  expect(alert.textContent).not.toContain('draft-canary');
  expect(alert.textContent).not.toContain('model-text-canary');
  expect(document.activeElement).toBe(alert);
  expect(submit.getAttribute('aria-describedby')).toBe(alert.id);
  expect(submit.matches(':disabled')).toBe(false);
  for (const input of container.querySelectorAll('input, textarea'))
    expect(input.matches(':disabled')).toBe(false);
  if (component === 'Quiz') {
    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>('input:checked'),
        (input) => input.value,
      ),
    ).toEqual(['b', 'a']);
  } else {
    expect(container.querySelector('textarea')?.value).toBe('  Private draft-canary.  ');
  }
  // The alert is immediately before submit, so one Tab reaches the retry action.
  await act(async () => userEvent.keyboard('{Tab}'));
  expect(document.activeElement).toBe(submit);
  await act(async () => userEvent.keyboard('{Enter}'));
  expect(instance.dispatch).toHaveBeenCalledTimes(2);
  expect(instance.dispatch.mock.calls[1]?.[0].payload).toEqual(payload);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(submit.hasAttribute('aria-describedby')).toBe(false);
  await act(async () =>
    retry.resolve({ status: 'accepted', interactionId: interaction().interactionId }),
  );
  expect(submit.matches(':disabled')).toBe(true);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
