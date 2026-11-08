// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type InteractionId,
  materializeSurface,
  type PendingInteraction,
  pendingFromSurface,
} from '@galaxie-ai/core';
import {
  type Component,
  type JsonObject,
  type MaterializedSurface,
  validateSurface,
} from '@galaxie-ai/ui-protocol';
import { act, type ReactElement, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  AgentSurface,
  type AgentSurfaceControls,
  type BoundActions,
  createRegistry,
  defineComponent,
  educationComponents,
  Feedback,
  Progress,
  Quiz,
  type QuizActions,
  type Registry,
  structuralComponents,
  WritingPrompt,
} from '../src/index.js';
import { FakeInstance, interaction, rejected } from './support/fake-instance.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(async () => {
  await act(async () => {
    for (const { root } of mounted) root.unmount();
  });
  for (const { container } of mounted.splice(0)) container.remove();
});

async function mount(
  instance: FakeInstance,
  registry: Registry,
  extra: Partial<Parameters<typeof AgentSurface>[0]> = {},
): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () =>
    root.render(
      <StrictMode>
        <AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" {...extra} />
      </StrictMode>,
    ),
  );
  return container;
}

const quizProps = {
  title: 'Practice',
  questions: [
    {
      id: 'q1',
      prompt: 'Choose one.',
      options: [
        { id: 'a', label: 'First' },
        { id: 'b', label: 'Second' },
      ],
    },
  ],
};
const registry = createRegistry({
  components: [...educationComponents, ...structuralComponents('education/v1')],
});

function record(
  components: readonly Component[],
  dataModel: JsonObject = {},
  registered = registry,
): MaterializedSurface {
  const catalog = registered.catalogs()['education/v1'];
  if (catalog === undefined) throw new Error('The education catalog is missing.');
  return materializeSurface({
    binding: { region: 'lesson-main', a2uiSurfaceId: 'lesson', catalogId: catalog.id },
    catalog,
    limits: { components: 50, payloadBytes: 1_048_576 },
    isAllowedUrl: () => false,
    messages: [{ version: '1.0', createSurface: { surfaceId: 'lesson', components, dataModel } }],
  });
}

function pending(
  surface: MaterializedSurface,
  id = `interaction-${surface.revision}`,
): PendingInteraction {
  return pendingFromSurface(id as InteractionId, surface);
}

async function draft(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      textarea,
      value,
    );
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

test('catalogs group registrations without changing the education export', () => {
  expect(educationComponents.map((entry) => entry.id)).toEqual([
    'education.Quiz/v1',
    'education.Feedback/v1',
    'education.Progress/v1',
    'education.WritingPrompt/v1',
  ]);
  expect(structuralComponents('education/v1').map((entry) => entry.id)).toEqual([
    'education.Column/v1',
    'education.Row/v1',
    'education.Text/v1',
    'education.Card/v1',
  ]);
  const other = defineComponent({
    id: 'other.Note/v2',
    props: z.strictObject({}),
    actions: {},
    component: () => null,
  });
  const grouped = createRegistry({ components: [...educationComponents, other] });
  expect(Object.keys(grouped.catalogs())).toEqual(['education/v1', 'other/v2']);
  for (const [id, catalog] of Object.entries(grouped.catalogs())) {
    expect(catalog.id).toBe(id);
    expect(catalog.functions).toBeUndefined();
  }
  expect(grouped.catalogs()['education/v1']?.components['Quiz']?.props).toBe(Quiz.props);
  expect(grouped.bindings({ surfaces: ['lesson-main'] }).catalogs).toBe(grouped.catalogs());
  const surface = record([
    { id: 'root', component: 'Card', children: ['quiz'] },
    { id: 'quiz', component: 'Quiz', ...quizProps },
  ]);
  expect(
    validateSurface(surface, {
      binding: surface,
      catalog: registry.catalogs()['education/v1']!,
      limits: { components: 50, payloadBytes: 1_048_576 },
      isAllowedUrl: () => false,
    }).ok,
  ).toBe(true);
});

test.each([
  ['Quiz', Quiz.id, quizProps, 'Submit answers'],
  ['WritingPrompt', WritingPrompt.id, { prompt: 'Write one sentence.' }, 'Submit sentence'],
  [
    'Feedback',
    Feedback.id,
    { items: [{ id: 'note', kind: 'info', text: 'Good work.' }] },
    'Continue',
  ],
  ['Progress', Progress.id, { label: 'Lesson progress', current: 1, total: 2 }, 'Continue'],
] as const)(
  '%s preserves the legacy DOM and trusted action labels',
  async (name, component, props, label) => {
    const legacy = new FakeInstance();
    legacy.setPending(interaction({ component, props }));
    const native = new FakeInstance();
    native.setPending(pending(record([{ id: 'root', component: name, ...props }])));
    const before = await mount(legacy, registry);
    const after = await mount(native, registry);
    // React allocates root-specific IDs. Compare markup after normalizing only those IDs.
    const markup = (element: HTMLElement): string =>
      element.innerHTML.replace(/_r_[a-z0-9]+_/g, 'generated-id');
    expect(markup(after)).toBe(markup(before));
    expect(after.querySelector('button')?.textContent).toBe(label);
    expect(after.querySelector('[aria-label], [hidden]')).toBeNull();
    expect(after.querySelectorAll('[role="status"]')).toHaveLength(1);
  },
);

test('composition renders ordered lists, nested groups and template-relative text without HTML', async () => {
  const surface = record(
    [
      { id: 'root', component: 'Column', children: ['heading', 'card', 'list'] },
      { id: 'heading', component: 'Text', text: { '@path': '/heading' } },
      { id: 'card', component: 'Card', children: ['quiz'] },
      { id: 'quiz', component: 'Quiz', ...quizProps },
      { id: 'list', component: 'Row', children: { componentId: 'item', path: '/items' } },
      { id: 'item', component: 'Text', text: { '@path': 'name' } },
    ],
    { heading: '<b>Practice</b>', items: [{ name: 'One' }, { name: 'Two' }] },
  );
  const instance = new FakeInstance();
  instance.setPending(pending(surface));
  const container = await mount(instance, registry);
  expect([...container.querySelectorAll('span')].map((element) => element.textContent)).toEqual([
    '<b>Practice</b>',
    'One',
    'Two',
  ]);
  expect(container.textContent?.indexOf('<b>Practice</b>')).toBeLessThan(
    container.textContent?.indexOf('Choose one.') ?? 0,
  );
  expect(container.querySelector('b')).toBeNull();
  expect(container.querySelector('fieldset legend')?.textContent).toBe('Choose one.');
});

test('native actions carry their component and unchanged model; all components share the guard', async () => {
  let submit: BoundActions<QuizActions>['submit'] | undefined;
  const wrapped = defineComponent({
    ...Quiz,
    component(input): ReactElement {
      submit = input.actions.submit;
      return <Quiz.component {...input} />;
    },
  });
  const registered = createRegistry({
    components: [wrapped, WritingPrompt, ...structuralComponents('education/v1')],
  });
  const surface = record(
    [
      { id: 'root', component: 'Card', children: ['quiz', 'writing'] },
      { id: 'quiz', component: 'Quiz', ...quizProps },
      { id: 'writing', component: 'WritingPrompt', prompt: 'Write.' },
    ],
    { context: 'Stored model' },
    registered,
  );
  const instance = new FakeInstance();
  instance.setPending(pending(surface));
  const container = await mount(instance, registered);
  await act(async () => container.querySelector<HTMLInputElement>('input[value="b"]')?.click());
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(instance.dispatch).toHaveBeenCalledExactlyOnceWith({
    instanceId: instance.instanceId,
    runId: 'run-1',
    interactionId: 'interaction-1',
    surfaceId: 'lesson-main',
    viewRevision: 'lesson#1',
    action: 'submit',
    payload: { answers: { q1: 'b' } },
    surfaceAction: { revision: 1, componentId: 'quiz', dataModel: surface.dataModel },
  });
  expect(instance.dispatch.mock.calls[0]?.[0].surfaceAction?.dataModel).toBe(
    instance.getSnapshot().run?.pending?.surface?.dataModel,
  );
  expect(container.querySelector('textarea')?.disabled).toBe(true);
  await act(async () =>
    expect(submit?.submit({ answers: { q1: 'a' } })).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'duplicate' },
    }),
  );
  expect(instance.dispatch).toHaveBeenCalledTimes(1);
});

test('legacy submissions omit surface metadata and stale receipts retain fixed alerts and status', async () => {
  let status: unknown;
  const wrapped = defineComponent({
    ...Quiz,
    component(input): ReactElement {
      status = input.status;
      return <Quiz.component {...input} />;
    },
  });
  for (const native of [false, true]) {
    const instance = new FakeInstance();
    instance.setPending(
      native
        ? pending(record([{ id: 'root', component: 'Quiz', ...quizProps }]))
        : interaction({ component: Quiz.id, props: quizProps }),
    );
    instance.dispatch.mockResolvedValueOnce(rejected('stale'));
    const container = await mount(instance, createRegistry({ components: [wrapped] }));
    await act(async () => container.querySelector<HTMLInputElement>('input')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
    expect(status).toEqual({ rejected: 'stale' });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'This question is no longer active.',
    );
    expect(Object.hasOwn(instance.dispatch.mock.calls[0]?.[0] ?? {}, 'surfaceAction')).toBe(native);
  }
});

test('new interactions preserve textarea identity, draft and focus while resetting status', async () => {
  const first = record([{ id: 'root', component: 'WritingPrompt', prompt: 'Write.' }], {
    counter: 1,
  });
  const instance = new FakeInstance();
  instance.setPending(pending(first));
  const container = await mount(instance, registry);
  const textarea = container.querySelector('textarea');
  if (textarea === null) throw new Error('The textarea is missing.');
  await draft(textarea, 'Local draft');
  instance.dispatch.mockResolvedValueOnce(rejected('stale'));
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    'This question is no longer active.',
  );
  textarea.focus();
  const second = { ...first, revision: 2, dataModel: { counter: 2 } };
  const snapshot = instance.getSnapshot();
  const run = snapshot.run;
  if (run === undefined) throw new Error('The run is missing.');
  await act(async () =>
    instance.setSnapshot({
      ...snapshot,
      run: { runId: run.runId, status: 'running', labels: [] },
    }),
  );
  expect(container.querySelector('textarea')).toBe(textarea);
  expect(document.activeElement).toBe(textarea);
  await act(async () => instance.setPending(pending(second)));
  expect(container.querySelector('textarea')).toBe(textarea);
  expect(textarea.value).toBe('Local draft');
  expect(textarea.disabled).toBe(false);
  expect(document.activeElement).toBe(textarea);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[role="status"]')?.textContent).toBe('');
  const third = {
    ...second,
    revision: 3,
    components: { root: { id: 'root', component: 'WritingPrompt', prompt: 'Write again.' } },
  };
  await act(async () => instance.setPending(pending(third)));
  expect(container.querySelector('textarea')).toBe(textarea);
  expect(textarea.value).toBe('Local draft');
  expect(document.activeElement).toBe(textarea);
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(container.querySelector('[role="status"]')?.textContent).toBe('This step changed.');
  expect(container.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
  expect(container.querySelector('[role="status"]')?.getAttribute('aria-atomic')).toBe('true');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(instance.recordRenderOutcome).toHaveBeenCalledTimes(3);
});

test('accessibility mappings add a wrapper only when explicitly present', async () => {
  const instance = new FakeInstance();
  instance.setPending(
    pending(
      record([
        {
          id: 'root',
          component: 'Text',
          text: 'Visible',
          accessibility: {
            label: 'Step name',
            description: 'Step description',
            live: 'assertive',
            hidden: true,
          },
        },
      ]),
    ),
  );
  const container = await mount(instance, registry);
  const wrapper = container.querySelector('[aria-label="Step name"]');
  expect(wrapper?.getAttribute('aria-live')).toBe('assertive');
  expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
  expect(wrapper?.hasAttribute('hidden')).toBe(true);
  const description = document.getElementById(wrapper?.getAttribute('aria-describedby') ?? '');
  expect(description?.textContent).toBe('Step description');
  expect(description?.hidden).toBe(true);
});

const valid = record([{ id: 'root', component: 'Text', text: 'Valid' }]);
test.each([
  ['unknown', 'unsupported', [{ id: 'root', component: 'Unknown' }]],
  ['props', 'invalid', [{ id: 'root', component: 'Quiz', questions: [] }]],
  ['child', 'invalid', [{ id: 'root', component: 'Card', children: ['missing'] }]],
  ['cycle', 'invalid', [{ id: 'root', component: 'Card', children: ['root'] }]],
  [
    'cap',
    'denied',
    Array.from({ length: 51 }, (_, n) => ({
      id: n === 0 ? 'root' : `text-${n}`,
      component: 'Text',
      text: 'Never shown',
    })),
  ],
  [
    'function',
    'unsupported',
    [{ id: 'root', component: 'Text', text: { '@call': 'formatString' } }],
  ],
] as const)(
  'a malformed %s fails once without mounting content and keeps cancel available',
  async (_name, code, components) => {
    const surface = {
      ...valid,
      components: Object.fromEntries(components.map((component) => [component.id, component])),
    };
    const instance = new FakeInstance();
    instance.setPending(pending(surface));
    const onError = vi.fn();
    let controls: AgentSurfaceControls | undefined;
    const container = await mount(instance, registry, {
      onError,
      fallback: (_error, current) => {
        controls = current;
        return <p role="alert">This step could not be shown.</p>;
      },
    });
    expect(container.textContent).toBe('This step could not be shown.');
    expect(instance.recordRenderOutcome).toHaveBeenCalledExactlyOnceWith({
      runId: 'run-1',
      interactionId: 'interaction-1',
      viewRevision: 'lesson#1',
      status: 'failed',
      code,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    await controls?.cancel();
    expect(instance.cancel).toHaveBeenCalledExactlyOnceWith('run-1');
  },
);

test('renderer URL extractors remain enforced when catalog URL names are absent', async () => {
  const link = defineComponent({
    id: 'education.Link/v1',
    props: z.strictObject({ url: z.string() }),
    actions: {},
    urls: (props) => [props.url],
    component: () => <p>Never shown</p>,
  });
  const registered = createRegistry({ components: [link] });
  expect(registered.catalogs()['education/v1']?.components['Link']?.urls).toBeUndefined();
  const instance = new FakeInstance();
  instance.setPending(
    pending({
      ...valid,
      components: {
        root: { id: 'root', component: 'Link', url: 'https://denied.example.test/private-canary' },
      },
    }),
  );
  const container = await mount(instance, registered);
  expect(container.textContent).toBe('This step could not be shown.');
  expect(instance.recordRenderOutcome.mock.calls[0]?.[0]).toMatchObject({
    status: 'failed',
    code: 'denied',
  });
});

test('optional missing bindings are absent before props validation', async () => {
  const entry = defineComponent({
    id: 'education.Optional/v1',
    props: z.strictObject({ text: z.string().optional() }),
    bindable: ['text'],
    actions: {},
    component: ({ props }) => <p>{props.text ?? 'Absent'}</p>,
  });
  const instance = new FakeInstance();
  instance.setPending(
    pending({
      ...valid,
      components: { root: { id: 'root', component: 'Optional', text: { '@path': '/missing' } } },
    }),
  );
  const container = await mount(instance, createRegistry({ components: [entry] }));
  expect(container.textContent).toBe('Absent');
});

test('continue rejections get the same fixed surface alert', async () => {
  const instance = new FakeInstance();
  instance.setPending(
    pending(record([{ id: 'root', component: 'Progress', current: 1, total: 2 }])),
  );
  instance.dispatch.mockResolvedValueOnce(rejected('stale'));
  const container = await mount(instance, registry);
  await act(async () => container.querySelector<HTMLButtonElement>('button')?.click());
  const alert = container.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe('This question is no longer active.');
  expect(document.activeElement).toBe(alert);
});

test('template expansion is capped and invalid disconnected declarations fail before mount', async () => {
  for (const [surface, code] of [
    [
      {
        ...valid,
        components: {
          root: {
            id: 'root',
            component: 'Column',
            children: { componentId: 'item', path: '/items' },
          },
          item: { id: 'item', component: 'Text', text: { '@path': 'text' } },
        },
        dataModel: { items: Array.from({ length: 50 }, () => ({ text: 'Never shown' })) },
      },
      'denied',
    ],
    [
      {
        ...valid,
        components: {
          ...valid.components,
          disconnected: { id: 'disconnected', component: 'Card', children: ['disconnected'] },
        },
      },
      'invalid',
    ],
    [
      {
        ...valid,
        components: {
          root: {
            id: 'root',
            component: 'Column',
            children: { componentId: 'item', path: '/items' },
          },
          item: { id: 'item', component: 'Text', text: { '@path': 'text' }, extra: true },
        },
        dataModel: { items: [] },
      },
      'invalid',
    ],
  ] as const) {
    const instance = new FakeInstance();
    instance.setPending(pending(surface));
    const container = await mount(instance, registry);
    expect(container.textContent).toBe('This step could not be shown.');
    expect(instance.recordRenderOutcome.mock.calls[0]?.[0]).toMatchObject({
      status: 'failed',
      code,
    });
  }
});

test('a render boundary reports once per native revision and recovers for the next interaction', async () => {
  const wrapped = defineComponent({
    ...WritingPrompt,
    component(input): ReactElement {
      if (input.props.prompt === 'throw') throw new Error('private-render-canary');
      return <WritingPrompt.component {...input} />;
    },
  });
  const registered = createRegistry({ components: [wrapped] });
  const instance = new FakeInstance();
  const first = record([{ id: 'root', component: 'WritingPrompt', prompt: 'throw' }]);
  instance.setPending(pending(first));
  const onError = vi.fn();
  const container = await mount(instance, registered, { onError });
  expect(container.textContent).toBe('This step could not be shown.');
  expect(container.children).toHaveLength(1);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(instance.recordRenderOutcome.mock.calls[0]?.[0]).toMatchObject({
    status: 'failed',
    code: 'render_failed',
  });
  await act(async () =>
    instance.setPending(
      pending({
        ...first,
        revision: 2,
        components: { root: { id: 'root', component: 'WritingPrompt', prompt: 'Recovered.' } },
      }),
    ),
  );
  expect(container.querySelector('textarea')?.labels?.[0]?.textContent).toBe('Recovered.');
  expect(onError).toHaveBeenCalledTimes(1);
  expect(instance.recordRenderOutcome).toHaveBeenCalledTimes(2);
  expect(instance.recordRenderOutcome.mock.calls[1]?.[0]).toMatchObject({
    status: 'rendered',
    viewRevision: 'lesson#2',
  });
});
