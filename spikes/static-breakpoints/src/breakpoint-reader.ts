// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { InteractionId, PendingInteraction, ViewRevision } from '@galaxie-ai/core';
import type { StateSnapshot } from '@langchain/langgraph';
import type { CheckpointTuple } from '@langchain/langgraph-checkpoint';
import { type FixtureGraph, question } from './graphs.js';

export interface Pause {
  readonly interaction: PendingInteraction;
  readonly resume: 'null' | 'map' | 'bare';
  readonly rawId?: string;
}

export function readBreakpoint(
  graph: FixtureGraph,
  snapshot: StateSnapshot,
  tuple: CheckpointTuple | undefined,
  allowMissingId: boolean,
): Pause | undefined {
  const interrupts = snapshot.tasks.flatMap((task) =>
    task.interrupts.map((pause) => ({ task, pause })),
  );
  if (interrupts.length > 0) {
    if (interrupts.length !== 1) throw new Error('Unsupported pause.');
    const item = interrupts[0]!;
    const { id, value } = item.pause;
    if (typeof value !== 'object' || value === null) throw new Error('Unsupported pause.');
    if (typeof id !== 'string' && !allowMissingId) throw new Error('Unsupported pause.');
    const resumeValues =
      tuple?.pendingWrites
        ?.filter(([task, channel]) => task === item.task.id && channel === '__resume__')
        .flatMap(([, , values]) => (Array.isArray(values) ? values : [values])) ?? [];
    return {
      interaction: {
        ...(value as Omit<PendingInteraction, 'interactionId'>),
        interactionId: (id ?? `idless:${item.task.id}:${resumeValues.length}`) as InteractionId,
      },
      resume: id === undefined ? 'bare' : 'map',
      ...(id === undefined ? {} : { rawId: id }),
    };
  }
  if (snapshot.tasks.some((task) => task.error !== undefined || task.state !== undefined))
    throw new Error('Unsupported pause.');
  if (snapshot.next.length === 0) return undefined;
  if (graph.interruptBefore === '*') throw new Error('Unsupported wildcard pause.');
  const matches = snapshot.tasks.filter(
    (task) => snapshot.next.includes(task.name) && graph.interruptBefore?.includes(task.name),
  );
  if (matches.length !== 1 || graph.interruptAfter?.length) throw new Error('Unsupported pause.');
  const task = matches[0]!;
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(task.name)) throw new Error('Unsupported node.');
  const checkpoint = snapshot.config.configurable?.['checkpoint_id'];
  if (typeof checkpoint !== 'string' || tuple?.checkpoint.id !== checkpoint)
    throw new Error('Unsupported checkpoint.');
  const identity = `breakpoint:before:${checkpoint}:${task.id}`;
  return {
    interaction: {
      interactionId: identity as InteractionId,
      ...question(task.name),
      viewRevision: identity as ViewRevision,
    },
    resume: 'null',
  };
}
