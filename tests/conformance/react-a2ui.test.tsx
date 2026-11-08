// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  type InteractionId,
  materializeSurface,
  pendingFromSurface,
} from '@galaxie-ai/core';
import {
  AgentSurface,
  type BoundActions,
  createRegistry,
  educationComponents,
  Quiz,
  type QuizActions,
  structuralComponents,
} from '@galaxie-ai/react';
import { act, type ReactElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { z } from 'zod';
import { collect, FakeExecutor, flush } from '../../packages/core/test/fake-executor.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test('a composed surface uses registry catalogs and resumes real core with its owning component', async () => {
  let submit: BoundActions<QuizActions>['submit'] | undefined;
  const quiz = {
    ...Quiz,
    component(input: Parameters<typeof Quiz.component>[0]): ReactElement {
      submit = input.actions.submit;
      return <Quiz.component {...input} />;
    },
  };
  const registry = createRegistry({
    components: [
      ...educationComponents.filter((entry) => entry.id !== Quiz.id),
      quiz,
      ...structuralComponents('education/v1'),
    ],
  });
  const catalog = registry.catalogs()['education/v1'];
  if (catalog === undefined) throw new Error('The catalog is missing.');
  const surface = materializeSurface({
    binding: { region: 'lesson-main', a2uiSurfaceId: 'practice', catalogId: catalog.id },
    catalog,
    limits: { components: 50, payloadBytes: 1_048_576 },
    isAllowedUrl: () => false,
    messages: [
      {
        version: '1.0',
        createSurface: {
          surfaceId: 'practice',
          dataModel: { title: '<b>Practice</b>' },
          components: [
            { id: 'root', component: 'Column', children: ['title', 'card'] },
            { id: 'title', component: 'Text', text: { '@path': '/title' } },
            {
              id: 'card',
              component: 'Card',
              children: ['quiz'],
              accessibility: { label: 'Practice card', description: 'Choose an answer.' },
            },
            {
              id: 'quiz',
              component: 'Quiz',
              questions: [
                {
                  id: 'q1',
                  prompt: 'Choose the past tense.',
                  options: [
                    { id: 'a', label: 'go' },
                    { id: 'b', label: 'went' },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  });
  const pending = pendingFromSurface('question' as InteractionId, surface);
  const executor = new FakeExecutor([
    [{ type: 'interaction', interaction: pending }],
    [{ type: 'output', output: { answered: true } }],
  ]);
  Object.assign(executor.features, { resume: true, checkpoints: true });
  executor.agent.pending = async () => (executor.requests.length === 1 ? pending : undefined);
  const runtime = createRuntime({ appId: 'react-a2ui', executors: [executor] });
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/react-a2ui',
      version: '1.0.0',
      executor: 'fake',
      input: z.string(),
      ui: {
        catalog: 'education/v1',
        components: ['Column', 'Card', 'Quiz', 'Text'],
        surfaces: ['lesson-main'],
      },
    }),
    { principalScope: 'fixture', agent: {}, ui: registry.bindings({ surfaces: ['lesson-main'] }) },
  );
  const dispatch = vi.spyOn(instance, 'dispatch');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await instance.prepare();
    const { runId } = await instance.start('input');
    await flush();
    await act(async () =>
      root.render(
        <StrictMode>
          <AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />
        </StrictMode>,
      ),
    );
    const view = page.elementLocator(container);
    expect(
      view
        .getByRole('group', { name: 'Practice card', exact: true })
        .element()
        .getAttribute('aria-describedby'),
    ).toBeTruthy();
    expect(
      view.getByRole('group', { name: 'Choose the past tense.', exact: true }).element().tagName,
    ).toBe('FIELDSET');
    expect(container.textContent).toContain('<b>Practice</b>');
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');
    await act(async () =>
      (view.getByRole('radio', { name: 'went', exact: true }).element() as HTMLElement).click(),
    );
    await act(async () => {
      (
        view.getByRole('button', { name: 'Submit answers', exact: true }).element() as HTMLElement
      ).click();
      await collect(instance.events(runId));
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({
      instanceId: instance.instanceId,
      runId,
      interactionId: pending.interactionId,
      surfaceId: 'lesson-main',
      viewRevision: pending.viewRevision,
      action: 'submit',
      payload: { answers: { q1: 'b' } },
      surfaceAction: { revision: 1, componentId: 'quiz', dataModel: surface.dataModel },
    });
    expect(instance.getSnapshot().run?.status).toBe('succeeded');
    expect(executor.requests[1]?.command).toEqual({
      type: 'resume',
      interactionId: pending.interactionId,
      action: 'submit',
      payload: { answers: { q1: 'b' } },
    });
    const events = await collect(instance.events(runId));
    expect(events.filter((event) => event.type === 'render')).toMatchObject([
      {
        status: 'rendered',
        interactionId: pending.interactionId,
        viewRevision: pending.viewRevision,
      },
    ]);
    await expect(submit?.submit({ answers: { q1: 'a' } })).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'duplicate' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await runtime.dispose();
  }
});
