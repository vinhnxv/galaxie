// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ReactElement } from 'react';
import { z } from 'zod';
import { type ComponentEntry, type ComponentProps, defineComponent } from '../registry.js';
import {
  type ContinueActions,
  continueActions,
  idSchema,
  longTextSchema,
  shortTextSchema,
  uniqueIds,
} from './schemas.js';

export interface FeedbackItem {
  readonly id: string;
  readonly kind: 'correct' | 'incorrect' | 'info';
  readonly text: string;
}

export interface FeedbackProps {
  readonly title?: string | undefined;
  readonly items: readonly FeedbackItem[];
}

const propsSchema = z.strictObject({
  title: shortTextSchema.optional(),
  items: z
    .array(
      z.strictObject({
        id: idSchema,
        kind: z.enum(['correct', 'incorrect', 'info']),
        text: longTextSchema,
      }),
    )
    .min(1)
    .max(20)
    .refine(uniqueIds),
});

function FeedbackView({
  props,
  actions,
  status,
}: ComponentProps<FeedbackProps, ContinueActions>): ReactElement {
  return (
    <section>
      {props.title === undefined ? null : <h2>{props.title}</h2>}
      <ul>
        {props.items.map((item) => (
          <li key={item.id}>
            {item.kind}: {item.text}
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={status === 'submitting' || status === 'accepted'}
        onClick={() => void actions.continue.submit({})}
      >
        {actions.continue.label}
      </button>
    </section>
  );
}

export const Feedback: ComponentEntry<FeedbackProps, ContinueActions, 'education.Feedback/v1'> =
  defineComponent<FeedbackProps, ContinueActions, 'education.Feedback/v1'>({
    id: 'education.Feedback/v1',
    props: propsSchema,
    actions: continueActions,
    component: FeedbackView,
  });
