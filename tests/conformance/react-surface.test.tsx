// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createLangGraphAdapter, requestInteraction } from '@galaxie-ai/adapter-langgraph';
import {
  createRuntime,
  defineAgentDefinition,
  type RunEvent,
  type ViewRevision,
} from '@galaxie-ai/core';
import {
  AgentSurface,
  type AgentSurfaceControls,
  type BoundActions,
  createRegistry,
  defineComponent,
  Quiz,
  type QuizActions,
  type QuizSubmission,
} from '@galaxie-ai/react';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph/web';
import { act, type ReactElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';
import { createSpanRecorder, serializeSpans } from '../../packages/core/test/span-tree.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test('a React surface resumes a real graph once and keeps old actions bound to their run', async () => {
  let captured: BoundActions<QuizActions>['submit'] | undefined;
  const entry = defineComponent({
    ...Quiz,
    component(input): ReactElement {
      captured = input.actions.submit;
      return <Quiz.component {...input} />;
    },
  });
  const registry = createRegistry({ components: [entry] });
  const runtime = createRuntime({
    appId: 'react-conformance',
    executors: [createLangGraphAdapter()],
  });
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/react-surface',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({ attempt: z.number().int() }),
      ui: { catalog: 'education/v1', components: ['Quiz'], surfaces: ['lesson-main'] },
    }),
    {
      principalScope: 'fixture',
      ui: registry.bindings({ surfaces: ['lesson-main'] }),
      agent: (host) => {
        const state = Annotation.Root({
          attempt: Annotation<number>,
          answers: Annotation<QuizSubmission['answers']>,
        });
        return new StateGraph(state)
          .addNode('ask', async (_state, config) => {
            await Promise.resolve();
            const submission = requestInteraction(
              {
                surfaceId: 'lesson-main',
                viewRevision: 'r1',
                component: 'education.Quiz/v1',
                props: {
                  title: 'Practice',
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
              },
              config,
            );
            return { answers: (submission.payload as QuizSubmission).answers };
          })
          .addEdge(START, 'ask')
          .addEdge('ask', END)
          .compile({ checkpointer: host.langchain.checkpointer() });
      },
    },
  );
  const dispatch = vi.spyOn(instance, 'dispatch');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await instance.prepare();
    const { runId } = await instance.start({ attempt: 1 });
    for await (const event of instance.events(runId)) {
      if (event.type === 'interaction') break;
    }
    const pending = instance.getSnapshot().run?.pending;
    if (pending === undefined) throw new Error('The graph did not reach its interaction.');
    await act(async () =>
      root.render(
        <StrictMode>
          <AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />
        </StrictMode>,
      ),
    );
    instance.recordRenderOutcome({
      runId,
      interactionId: pending.interactionId,
      viewRevision: 'older' as ViewRevision,
      status: 'failed',
      code: 'render_failed',
    });
    if (captured === undefined) throw new Error('The Quiz was not rendered.');
    const oldAction = captured;
    const radio = container.querySelector<HTMLInputElement>('input[value="b"]');
    const button = container.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (radio === null || button === null) throw new Error('The Quiz controls were not rendered.');
    expect(button.disabled).toBe(true);
    await act(async () => radio.click());
    expect(button.disabled).toBe(false);
    const events: RunEvent[] = [];
    await act(async () => {
      button.click();
      for await (const event of instance.events(runId)) events.push(event);
    });
    expect(events.filter((event) => event.type === 'render')).toMatchObject([
      {
        status: 'rendered',
        interactionId: pending.interactionId,
        viewRevision: pending.viewRevision,
      },
    ]);
    expect(instance.getSnapshot().run?.status).toBe('succeeded');
    expect(events.find((event) => event.type === 'output')).toMatchObject({
      output: { answers: { q1: 'b' } },
    });
    expect(container.childElementCount).toBe(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(dispatch.mock.results[0]?.value).resolves.toEqual({
      status: 'accepted',
      interactionId: pending.interactionId,
    });
    const payload: QuizSubmission = { answers: { q1: 'b' } };
    await expect(oldAction.submit(payload)).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'duplicate' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);

    let nextRunId: typeof runId | undefined;
    await act(async () => {
      ({ runId: nextRunId } = await instance.start({ attempt: 2 }));
      for await (const event of instance.events(nextRunId)) {
        if (event.type === 'interaction') break;
      }
    });
    expect(nextRunId).not.toBe(runId);
    const nextSnapshot = instance.getSnapshot();
    expect(nextSnapshot.run?.status).toBe('waiting_input');
    await expect(oldAction.submit(payload)).resolves.toMatchObject({
      status: 'rejected',
      error: { code: 'stale' },
    });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]?.[0]).toEqual({
      instanceId: instance.instanceId,
      runId,
      interactionId: pending.interactionId,
      surfaceId: pending.surfaceId,
      viewRevision: pending.viewRevision,
      action: 'submit',
      payload,
    });
    expect(instance.getSnapshot()).toBe(nextSnapshot);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await runtime.dispose();
  }
});

test('a throwing real graph surface journals a content-free failure, stays paused and can cancel', async () => {
  const { exporter, provider } = createSpanRecorder();
  const registry = createRegistry({
    components: [
      defineComponent({
        ...Quiz,
        component: ({ props }): ReactElement => {
          throw new Error(`private-thrown-message-canary: ${props.title}`);
        },
      }),
    ],
  });
  const runtime = createRuntime({
    appId: 'react-render-conformance',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
  });
  const instance = await runtime.create(
    defineAgentDefinition({
      id: 'conformance/render-failure',
      version: '1.0.0',
      executor: 'langgraph-js',
      input: z.object({}),
      ui: { catalog: 'education/v1', components: ['Quiz'], surfaces: ['lesson-main'] },
    }),
    {
      principalScope: 'fixture',
      ui: registry.bindings({ surfaces: ['lesson-main'] }),
      agent: (host) =>
        new StateGraph(Annotation.Root({ done: Annotation<boolean> }))
          .addNode('ask', async (_state, config) => {
            await Promise.resolve();
            requestInteraction(
              {
                surfaceId: 'lesson-main',
                viewRevision: 'r1',
                component: 'education.Quiz/v1',
                props: {
                  title: 'private-render-props-canary',
                  questions: [
                    {
                      id: 'q1',
                      prompt: 'Question',
                      options: [
                        { id: 'a', label: 'One' },
                        { id: 'b', label: 'Two' },
                      ],
                    },
                  ],
                },
              },
              config,
            );
            return { done: true };
          })
          .addEdge(START, 'ask')
          .addEdge('ask', END)
          .compile({ checkpointer: host.langchain.checkpointer() }),
    },
  );
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const onError = vi.fn();
  let controls: AgentSurfaceControls | undefined;
  try {
    await instance.prepare();
    const { runId } = await instance.start({});
    for await (const event of instance.events(runId)) {
      if (event.type === 'interaction') break;
    }
    await act(async () =>
      root.render(
        <StrictMode>
          <p data-host>Host remains</p>
          <AgentSurface
            instance={instance}
            registry={registry}
            surfaceId="lesson-main"
            onError={onError}
            fallback={(error, current) => {
              controls = current;
              return <p role="alert">{error.message}</p>;
            }}
          />
        </StrictMode>,
      ),
    );
    expect(instance.getSnapshot().run?.status).toBe('waiting_input');
    expect(instance.getSnapshot().run?.pending).toBeDefined();
    expect(onError).toHaveBeenCalledExactlyOnceWith({
      code: 'render_failed',
      message: 'The step could not be shown.',
    });
    expect(container.querySelector('[data-host]')?.textContent).toBe('Host remains');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'The step could not be shown.',
    );
    const pending = instance.getSnapshot().run?.pending;
    for await (const event of instance.events(runId)) {
      if (event.type === 'render') {
        expect(event).toMatchObject({ status: 'failed', code: 'render_failed' });
        break;
      }
    }
    if (controls === undefined) throw new Error('The failure controls were not supplied.');
    const currentControls = controls;
    await act(async () => currentControls.cancel());
    expect(instance.getSnapshot().run?.status).toBe('cancelled');
    const renders = (await collect(instance.events(runId))).filter(
      (event) => event.type === 'render',
    );
    expect(renders).toEqual([
      {
        type: 'render',
        runId,
        interactionId: pending?.interactionId,
        viewRevision: pending?.viewRevision,
        status: 'failed',
        code: 'render_failed',
        eventId: expect.any(String),
        sequence: expect.any(Number),
      },
    ]);
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const observation =
      container.innerHTML + JSON.stringify([renders, onError.mock.calls]) + serializeSpans(spans);
    for (const secret of ['private-thrown-message-canary', 'private-render-props-canary']) {
      expect(observation).not.toContain(secret);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    await runtime.dispose();
  }
});
