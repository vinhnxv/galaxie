// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type DispatchReceipt, readAnnotations, validateSync } from '@galaxie-ai/core';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test } from 'vitest';
import {
  AgentSurface,
  createRegistry,
  educationComponents,
  Feedback,
  Progress,
  Quiz,
  WritingPrompt,
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

function quizProps() {
  return {
    title: 'Practice',
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
}

async function renderInteraction(
  component: typeof Quiz.id | typeof Feedback.id | typeof Progress.id | typeof WritingPrompt.id,
  props: unknown,
) {
  const instance = new FakeInstance();
  instance.setPending(interaction({ component, props }));
  const registry = createRegistry({ components: educationComponents });
  const container = await mount(
    <AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />,
  );
  return { instance, container };
}

test('education entries expose one catalog and answer actions', () => {
  const registry = createRegistry({ components: educationComponents });
  expect(educationComponents.map((entry) => entry.id)).toEqual([
    'education.Quiz/v1',
    'education.Feedback/v1',
    'education.Progress/v1',
    'education.WritingPrompt/v1',
  ]);
  expect(Object.keys(registry.bindings({ surfaces: ['lesson-main'] }).components)).toHaveLength(4);
});

test('Quiz uses labelled fieldsets and radios, and submits only complete answers', async () => {
  const { instance, container } = await renderInteraction(Quiz.id, quizProps());
  expect(Array.from(container.querySelectorAll('legend'), (legend) => legend.textContent)).toEqual([
    'First question',
    'Second question',
  ]);
  const radios = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="radio"]'));
  expect(radios).toHaveLength(4);
  for (const radio of radios) expect(radio.labels?.[0]?.textContent).toBeTruthy();
  expect(radios[0]?.name).toBe(radios[1]?.name);
  expect(radios[0]?.name).not.toBe(radios[2]?.name);
  const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
  expect(button?.textContent).toBe(Quiz.actions.submit.label);
  expect(button?.disabled).toBe(true);
  await act(async () => radios[1]?.click());
  expect(button?.disabled).toBe(true);
  await act(async () =>
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(instance.dispatch).not.toHaveBeenCalled();
  await act(async () => radios[2]?.click());
  expect(button?.disabled).toBe(false);
  const completion = Promise.withResolvers<DispatchReceipt>();
  instance.dispatch.mockReturnValueOnce(completion.promise);
  await act(async () => button?.click());
  expect(button?.disabled).toBe(true);
  expect(instance.dispatch).toHaveBeenCalledTimes(1);
  expect(instance.dispatch.mock.calls[0]?.[0]).toMatchObject({
    action: 'submit',
    payload: { answers: { q1: 'b', q2: 'a' } },
  });
  await act(async () =>
    completion.resolve({ status: 'accepted', interactionId: interaction().interactionId }),
  );
});

test('model markup remains text in every education component', async () => {
  const markup = '<img src=x onerror=alert(1)>';
  const props = quizProps();
  props.title = markup;
  const firstQuestion = props.questions[0];
  const firstOption = firstQuestion?.options[0];
  if (firstQuestion === undefined || firstOption === undefined)
    throw new Error('The quiz fixture is empty.');
  firstQuestion.prompt = markup;
  firstOption.label = markup;
  const quiz = await renderInteraction(Quiz.id, props);
  const feedback = await renderInteraction(Feedback.id, {
    title: markup,
    items: [{ id: 'f1', kind: 'info', text: markup }],
  });
  const progress = await renderInteraction(Progress.id, { label: markup, current: 1, total: 2 });
  for (const { container } of [quiz, feedback, progress]) {
    expect(container.textContent).toContain(markup);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
  }
});

const invalidQuizzes: [string, () => unknown][] = [
  ['no questions', () => ({ questions: [] })],
  [
    '21 questions',
    () => ({
      questions: Array.from({ length: 21 }, (_, n) => ({
        ...quizProps().questions[0],
        id: `q${n}`,
      })),
    }),
  ],
  [
    'one option',
    () => ({ questions: [{ ...quizProps().questions[0], options: [{ id: 'a', label: 'Only' }] }] }),
  ],
  [
    'seven options',
    () => ({
      questions: [
        {
          ...quizProps().questions[0],
          options: Array.from({ length: 7 }, (_, n) => ({ id: `o${n}`, label: 'Option' })),
        },
      ],
    }),
  ],
  [
    'long prompt',
    () => ({ questions: [{ ...quizProps().questions[0], prompt: 'x'.repeat(2001) }] }),
  ],
  ['long title', () => ({ ...quizProps(), title: 'x'.repeat(201) })],
  [
    'long option label',
    () => ({
      questions: [
        {
          ...quizProps().questions[0],
          options: [
            { id: 'a', label: 'x'.repeat(201) },
            { id: 'b', label: 'Other' },
          ],
        },
      ],
    }),
  ],
  [
    'duplicate question IDs',
    () => ({ questions: [quizProps().questions[0], quizProps().questions[0]] }),
  ],
  [
    'duplicate option IDs',
    () => ({
      questions: [
        {
          ...quizProps().questions[0],
          options: [
            { id: 'a', label: 'One' },
            { id: 'a', label: 'Two' },
          ],
        },
      ],
    }),
  ],
  ['long ID', () => ({ questions: [{ ...quizProps().questions[0], id: 'x'.repeat(65) }] })],
  ['invalid ID characters', () => ({ questions: [{ ...quizProps().questions[0], id: 'q 1' }] })],
];

test.each(invalidQuizzes)('Quiz rejects %s before rendering', (_reason, props) => {
  const registry = createRegistry({ components: educationComponents });
  expect(registry.resolve(interaction({ component: Quiz.id, props: props() }))).toEqual({
    ok: false,
    error: { code: 'invalid', message: 'The request is invalid.' },
  });
});

test('Quiz preserves a question named __proto__ in the submitted payload', async () => {
  const props = { questions: [{ ...quizProps().questions[0], id: '__proto__' }] };
  const { instance, container } = await renderInteraction(Quiz.id, props);
  await act(async () => container.querySelector<HTMLInputElement>('input[type="radio"]')?.click());
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  const payload = instance.dispatch.mock.calls[0]?.[0].payload;
  expect(JSON.stringify(payload)).toBe('{"answers":{"__proto__":"a"}}');
  expect(Object.hasOwn((payload as { answers: object }).answers, '__proto__')).toBe(true);
});

test.each([
  { answers: {} },
  { answers: Object.fromEntries(Array.from({ length: 21 }, (_, n) => [`q${n}`, 'a'])) },
  { answers: { ['x'.repeat(65)]: 'a' } },
  { answers: { q1: 'x'.repeat(65) } },
  { answers: { q1: 1 } },
])('Quiz bounds the answer payload shape', (payload) => {
  expect(validateSync(Quiz.actions.submit.payload, payload)).toEqual({ ok: false });
});

test('Feedback renders its list and trusted continue action', async () => {
  const { instance, container } = await renderInteraction(Feedback.id, {
    title: 'Feedback',
    items: [
      { id: 'f1', kind: 'correct', text: 'Good answer' },
      { id: 'f2', kind: 'incorrect', text: 'Try again' },
      { id: 'f3', kind: 'info', text: 'A note' },
    ],
  });
  expect(container.querySelectorAll('ul li')).toHaveLength(3);
  expect(container.textContent).toContain('Good answer');
  expect(container.textContent).toContain('Try again');
  const button = container.querySelector<HTMLButtonElement>('button');
  expect(button?.textContent).toBe(Feedback.actions.continue.label);
  await act(async () => button?.click());
  expect(instance.dispatch.mock.calls[0]?.[0]).toMatchObject({ action: 'continue', payload: {} });
});

test.each([
  { items: [] },
  { items: Array.from({ length: 21 }, (_, n) => ({ id: `f${n}`, kind: 'info', text: 'Note' })) },
  { title: 'x'.repeat(201), items: [{ id: 'f1', kind: 'info', text: 'Note' }] },
  { items: [{ id: 'f1', kind: 'info', text: 'x'.repeat(2001) }] },
  { items: [{ id: 'x'.repeat(65), kind: 'info', text: 'Note' }] },
  { items: [{ id: 'f1', kind: 'other', text: 'Note' }] },
  {
    items: [
      { id: 'f1', kind: 'info', text: 'One' },
      { id: 'f1', kind: 'info', text: 'Two' },
    ],
  },
])('Feedback bounds and validates its items', (props) => {
  expect(
    createRegistry({ components: educationComponents }).resolve(
      interaction({ component: Feedback.id, props }),
    ),
  ).toEqual({
    ok: false,
    error: { code: 'invalid', message: 'The request is invalid.' },
  });
});

test('Progress renders a native value, max, text equivalent and continue action', async () => {
  const { instance, container } = await renderInteraction(Progress.id, {
    label: 'Lesson progress',
    current: 2,
    total: 5,
  });
  const progress = container.querySelector('progress');
  expect(progress?.value).toBe(2);
  expect(progress?.max).toBe(5);
  expect(progress?.labels?.[0]?.textContent).toBe('Lesson progress');
  expect(container.textContent).toContain('2 / 5');
  const button = container.querySelector<HTMLButtonElement>('button');
  expect(button?.textContent).toBe(Progress.actions.continue.label);
  await act(async () => button?.click());
  expect(instance.dispatch.mock.calls[0]?.[0]).toMatchObject({ action: 'continue', payload: {} });
});

test.each([
  { current: -1, total: 1 },
  { current: 1, total: 0 },
  { current: 2, total: 1 },
  { current: 1.5, total: 2 },
  { current: 0, total: 2.5 },
  { current: 0, total: 1001 },
  { current: 0, total: 1, label: 'x'.repeat(201) },
])('Progress rejects invalid bounds', (props) => {
  expect(
    createRegistry({ components: educationComponents }).resolve(
      interaction({ component: Progress.id, props }),
    ),
  ).toEqual({
    ok: false,
    error: { code: 'invalid', message: 'The request is invalid.' },
  });
});

test('continue payloads are empty objects', () => {
  for (const entry of [Feedback, Progress]) {
    expect(validateSync(entry.actions.continue.payload, {})).toMatchObject({ ok: true });
    expect(validateSync(entry.actions.continue.payload, { unexpected: true })).toEqual({
      ok: false,
    });
  }
});

test('WritingPrompt renders text and submits a non-empty trimmed sentence once', async () => {
  const markup = '<img src=x onerror=alert(1)>';
  const { instance, container } = await renderInteraction(WritingPrompt.id, {
    title: 'Writing practice',
    prompt: markup,
    placeholder: 'One sentence',
  });
  expect(container.textContent).toContain(markup);
  expect(container.querySelector('img')).toBeNull();
  const textarea = container.querySelector('textarea');
  const button = container.querySelector<HTMLButtonElement>('button');
  expect(textarea?.labels?.[0]?.textContent).toBe(markup);
  expect(textarea?.placeholder).toBe('One sentence');
  expect(textarea?.maxLength).toBe(500);
  expect(button?.disabled).toBe(true);
  const setDraft = async (value: string): Promise<void> => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        textarea,
        value,
      );
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  await setDraft('   ');
  expect(button?.disabled).toBe(true);
  await setDraft('  I study English every day.  ');
  expect(button?.disabled).toBe(false);
  const completion = Promise.withResolvers<DispatchReceipt>();
  instance.dispatch.mockReturnValueOnce(completion.promise);
  await act(async () => button?.click());
  expect(button?.disabled).toBe(true);
  await act(async () => button?.click());
  expect(instance.dispatch).toHaveBeenCalledTimes(1);
  expect(instance.dispatch.mock.calls[0]?.[0]).toMatchObject({
    action: 'submit',
    payload: { sentence: 'I study English every day.' },
  });
  await act(async () =>
    completion.resolve({ status: 'accepted', interactionId: interaction().interactionId }),
  );
});

test('WritingPrompt binds its private schema and rejects an oversized sentence before dispatch', async () => {
  let submit: ((payload: { sentence: string }) => Promise<DispatchReceipt>) | undefined;
  const entry = {
    ...WritingPrompt,
    component: (input: Parameters<typeof WritingPrompt.component>[0]): ReactElement => {
      submit = input.actions.submit.submit;
      return <p>{input.props.prompt}</p>;
    },
  };
  const registry = createRegistry({ components: [entry] });
  const schema = registry.bindings({ surfaces: ['lesson-main'] }).components[WritingPrompt.id]
    ?.actions['submit']?.payload;
  expect(schema).toBeDefined();
  if (schema === undefined) throw new Error('The writing schema is missing.');
  expect([...readAnnotations(schema).labels]).toEqual(['private-user']);
  const instance = new FakeInstance();
  instance.setPending(
    interaction({ component: WritingPrompt.id, props: { prompt: 'Write a sentence.' } }),
  );
  await mount(<AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />);
  expect(await submit?.({ sentence: 'x'.repeat(501) })).toMatchObject({
    status: 'rejected',
    error: { code: 'invalid' },
  });
  expect(instance.dispatch).not.toHaveBeenCalled();
});
