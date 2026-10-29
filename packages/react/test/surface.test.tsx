// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  DispatchReceipt,
  InteractionId,
  RunId,
  StandardSchema,
  ViewRevision,
} from '@galaxie/core';
import { act, type ReactElement, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import {
  AgentSurface,
  type ComponentProps,
  createRegistry,
  defineComponent,
  useAgentSnapshot,
} from '../src/index.js';
import { FakeInstance, interaction, rejected } from './support/fake-instance.js';

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

const propsSchema = z.object({
  title: z.string(),
  label: z.string().optional(),
  image: z.string().optional(),
});
const actions = {
  submit: { label: 'Host submit', payload: z.object({ answer: z.string().min(1) }) },
};
type Input = ComponentProps<z.output<typeof propsSchema>, typeof actions>;

function Probe({ props, actions, status }: Input): ReactElement {
  const [draft, setDraft] = useState('');
  return (
    <section>
      <h1>{props.title}</h1>
      <label>
        Draft
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <p data-draft>{draft}</p>
      <button type="button" onClick={() => void actions.submit.submit({ answer: draft })}>
        {actions.submit.label}
      </button>
      <output>{typeof status === 'string' ? status : status.rejected}</output>
    </section>
  );
}

function fixture(payload: StandardSchema = actions.submit.payload) {
  let captured: Input | undefined;
  const entry = defineComponent({
    id: 'tests.Question/v1',
    props: propsSchema,
    actions: { submit: { label: actions.submit.label, payload } },
    urls: (props) => (props.image === undefined ? [] : [props.image]),
    component: (input): ReactElement => {
      captured = input as Input;
      return <Probe {...captured} />;
    },
  });
  const registry = createRegistry({ components: [entry] });
  const instance = new FakeInstance();
  instance.setPending(interaction());
  const bound = (): Input['actions']['submit'] => {
    if (captured === undefined) throw new Error('The component fixture was not rendered.');
    return captured.actions.submit;
  };
  return { registry, instance, bound };
}

test('an empty surface and an interaction for another surface render nothing', async () => {
  const { registry } = fixture();
  const instance = new FakeInstance();
  const { container } = await mount(
    <AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />,
  );
  expect(container.textContent).toBe('');
  await act(async () => instance.setPending(interaction({ surfaceId: 'sidebar' })));
  expect(container.textContent).toBe('');
  expect(instance.dispatch).not.toHaveBeenCalled();
});

test('the surface renders validated props and registry action labels', async () => {
  const { registry, instance } = fixture();
  instance.setPending(interaction({ props: { title: 'Quiz', label: 'Model submit' } }));
  const { container } = await mount(
    <AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />,
  );
  expect(container.querySelector('h1')?.textContent).toBe('Quiz');
  expect(container.querySelector('button')?.textContent).toBe('Host submit');
  expect(container.textContent).not.toContain('Model submit');
});

test.each([
  ['unsupported', { component: 'tests.Unknown/v1' as const }],
  ['invalid', { props: { title: 1 } }],
  ['denied', { props: { title: 'Question', image: 'https://images.example.test/private-canary' } }],
] as const)(
  'rejected interactions report %s once from an effect under Strict Mode',
  async (code, overrides) => {
    const { registry, instance } = fixture();
    instance.setPending(interaction(overrides));
    const onError = vi.fn();
    const fallback = vi.fn((error) => <p data-error={error.code}>{error.message}</p>);
    const element = (
      <StrictMode>
        <AgentSurface
          instance={instance}
          registry={registry}
          surfaceId="lesson-main"
          onError={onError}
          fallback={fallback}
        />
      </StrictMode>
    );
    const { root, container } = await mount(element);
    expect(container.querySelector('[data-error]')?.getAttribute('data-error')).toBe(code);
    expect(container.querySelector('button')).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code });
    expect(JSON.stringify(onError.mock.calls)).not.toContain('private-canary');
    await act(async () => root.render(element));
    expect(onError).toHaveBeenCalledTimes(1);
  },
);

test('an old bound action dispatches its render-time identity and is stale', async () => {
  const { registry, instance, bound } = fixture();
  await mount(<AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />);
  const old = bound();
  const original = instance.getSnapshot().run;
  await act(async () =>
    instance.setPending(interaction({ interactionId: 'interaction-2' as InteractionId })),
  );
  let result: DispatchReceipt | undefined;
  await act(async () => {
    result = await old.submit({ answer: 'answer' });
  });
  expect(result).toMatchObject({ status: 'rejected', error: { code: 'stale' } });
  expect(instance.dispatch).toHaveBeenCalledWith({
    instanceId: instance.instanceId,
    runId: original?.runId,
    interactionId: 'interaction-1',
    surfaceId: 'lesson-main',
    viewRevision: 'r1',
    action: 'submit',
    payload: { answer: 'answer' },
  });
});

test('same-tick submits dispatch once; rejection permits retry and acceptance stays accepted', async () => {
  const { registry, instance, bound } = fixture();
  const gate = Promise.withResolvers<DispatchReceipt>();
  instance.dispatch.mockReturnValueOnce(gate.promise);
  const { container } = await mount(
    <AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />,
  );
  let first: Promise<DispatchReceipt> | undefined;
  await act(async () => {
    first = bound().submit({ answer: 'answer' });
    await expect(bound().submit({ answer: 'answer' })).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'duplicate' },
    });
  });
  expect(instance.dispatch).toHaveBeenCalledTimes(1);
  expect(container.querySelector('output')?.textContent).toBe('submitting');
  await act(async () => {
    gate.resolve(rejected());
    await first;
  });
  expect(container.querySelector('output')?.textContent).toBe('invalid');
  await act(async () => {
    await expect(bound().submit({ answer: 'answer' })).resolves.toMatchObject({
      status: 'accepted',
    });
  });
  expect(container.querySelector('output')?.textContent).toBe('accepted');
  await act(async () => {
    await expect(bound().submit({ answer: 'answer' })).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'duplicate' },
    });
  });
  expect(instance.dispatch).toHaveBeenCalledTimes(2);
  expect(container.querySelector('output')?.textContent).toBe('accepted');
});

test.each([
  actions.submit.payload,
  z.unknown().refine(() => {
    throw new Error('schema-canary');
  }),
  z.unknown().refine(async () => true),
])('invalid and throwing or asynchronous payload validators never dispatch', async (schema) => {
  const { registry, instance, bound } = fixture(schema);
  const { container } = await mount(
    <AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />,
  );
  await act(async () => {
    await expect(bound().submit({ answer: '' })).resolves.toEqual({
      status: 'rejected',
      error: { code: 'invalid', message: 'The request is invalid.' },
    });
  });
  expect(instance.dispatch).not.toHaveBeenCalled();
  expect(container.querySelector('output')?.textContent).toBe('invalid');
});

test('a thrown dispatch error is content-free and releases the guard for retry', async () => {
  const { registry, instance, bound } = fixture();
  instance.dispatch.mockRejectedValueOnce(new Error('host-error-canary'));
  await mount(<AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />);
  await act(async () => {
    const result = await bound().submit({ answer: 'answer' });
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'executor_error' } });
    expect(JSON.stringify(result)).not.toContain('host-error-canary');
    await expect(bound().submit({ answer: 'answer' })).resolves.toMatchObject({
      status: 'accepted',
    });
  });
  expect(instance.dispatch).toHaveBeenCalledTimes(2);
});

test('an accepted action from a previous run still reaches core as stale', async () => {
  const { registry, instance, bound } = fixture();
  await mount(<AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />);
  const old = bound();
  await act(async () => {
    await old.submit({ answer: 'answer' });
  });
  await act(async () => instance.setPending(interaction(), 'run-2'));
  await act(async () => {
    await expect(old.submit({ answer: 'answer' })).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'stale' },
    });
  });
  expect(instance.dispatch).toHaveBeenLastCalledWith(
    expect.objectContaining({ runId: 'run-1' as RunId }),
  );
  expect(instance.dispatch).toHaveBeenCalledTimes(2);
});

test.each([
  { interactionId: 'interaction-2' as InteractionId },
  { viewRevision: 'r2' as ViewRevision },
])('a changed interaction identity remounts component-local drafts', async (overrides) => {
  const { registry, instance } = fixture();
  const { container } = await mount(
    <AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />,
  );
  const input = container.querySelector('input');
  if (input === null) throw new Error('The input fixture was not rendered.');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      'local draft',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(input.value).toBe('local draft');
    expect(container.querySelector('[data-draft]')?.textContent).toBe('local draft');
  await act(async () => instance.setPending(interaction(overrides)));
  expect(container.querySelector('input')).not.toBe(input);
  expect(container.querySelector('input')?.value).toBe('');
});

test('Strict Mode rerenders and instance switches release subscriptions without lifecycle work', async () => {
  const { registry, instance } = fixture();
  const other = new FakeInstance('instance-2');
  other.setPending(interaction());
  function Snapshot({ instance }: { instance: FakeInstance }): ReactElement {
    const snapshot = useAgentSnapshot(instance);
    return <p>{snapshot.instanceId}</p>;
  }
  const view = (current: FakeInstance): ReactElement => (
    <StrictMode>
      <Snapshot instance={current} />
      <AgentSurface instance={current} registry={registry} surfaceId="lesson-main" />
    </StrictMode>
  );
  const { root } = await mount(view(instance));
  await act(async () => root.render(view(instance)));
  expect(instance.subscriberCount).toBe(2);
  await act(async () => root.render(view(other)));
  expect(instance.subscriberCount).toBe(0);
  expect(instance.subscribeCalls).toBe(instance.unsubscribeCalls);
  expect(other.subscriberCount).toBe(2);
  await act(async () => root.unmount());
  roots.splice(roots.indexOf(root), 1);
  expect(other.subscriberCount).toBe(0);
  expect(other.subscribeCalls).toBe(other.unsubscribeCalls);
  for (const current of [instance, other]) {
    expect(current.prepare).not.toHaveBeenCalled();
    expect(current.start).not.toHaveBeenCalled();
    expect(current.cancel).not.toHaveBeenCalled();
    expect(current.dispose).not.toHaveBeenCalled();
    expect(current.dispatch).not.toHaveBeenCalled();
  }
});
