// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { AgentInstance, DispatchReceipt, PendingInteraction } from '@galaxie/core';
import { createElement, type ReactElement } from 'react';
import { z } from 'zod';
import { Quiz } from './quiz.js';

export const quizProps = z.object({
  questions: z
    .array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        options: z.array(z.string()).length(3),
      }),
    )
    .length(3),
});
export type QuizProps = z.infer<typeof quizProps>;
export type Instance = AgentInstance<unknown, unknown>;
export type RegistryError = {
  code: 'unknown_component' | 'invalid_props' | 'invalid_action';
  message: string;
};
export const registry = [
  {
    component: 'education.Quiz/v1',
    props: quizProps,
    actions: ['submit'] as readonly string[],
    Component: Quiz,
  },
] as const;

type RenderResult = { ok: true; element: ReactElement } | { ok: false; error: RegistryError };
export function renderInteraction(instance: Instance, pending: PendingInteraction): RenderResult {
  const entry = registry.find((entry) => entry.component === pending.component);
  if (!entry)
    return { ok: false, error: { code: 'unknown_component', message: 'Unknown component.' } };
  const parsed = entry.props.safeParse(pending.props);
  if (!parsed.success)
    return { ok: false, error: { code: 'invalid_props', message: 'Invalid component props.' } };
  return {
    ok: true,
    element: createElement(entry.Component, {
      ...parsed.data,
      instance,
      pending,
      key: pending.interactionId,
    }),
  };
}

export function submit(
  instance: Instance,
  pending: PendingInteraction,
  action: string,
  payload: unknown,
): Promise<DispatchReceipt | { status: 'rejected'; error: RegistryError }> {
  const entry = registry.find((entry) => entry.component === pending.component);
  if (!entry)
    return Promise.resolve({
      status: 'rejected',
      error: { code: 'unknown_component', message: 'Unknown component.' },
    });
  if (!entry.actions.includes(action))
    return Promise.resolve({
      status: 'rejected',
      error: { code: 'invalid_action', message: 'Invalid component action.' },
    });
  const snapshot = instance.getSnapshot();
  const run = snapshot.run;
  if (!run) throw new Error('No active run.');
  return instance.dispatch({
    instanceId: snapshot.instanceId,
    runId: run.runId,
    interactionId: pending.interactionId,
    surfaceId: pending.surfaceId,
    viewRevision: pending.viewRevision,
    action,
    payload,
  });
}
