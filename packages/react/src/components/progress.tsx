// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type ReactElement, useId } from 'react';
import { z } from 'zod';
import { type ComponentEntry, type ComponentProps, defineComponent } from '../registry.js';
import { type ContinueActions, continueActions, shortTextSchema } from './schemas.js';

export interface ProgressProps {
  readonly label?: string | undefined;
  readonly current: number;
  readonly total: number;
}

const propsSchema = z
  .strictObject({
    label: shortTextSchema.optional(),
    current: z.number().int().min(0).max(1000),
    total: z.number().int().min(1).max(1000),
  })
  .refine((props) => props.current <= props.total);

function ProgressView({
  props,
  actions,
  status,
}: ComponentProps<ProgressProps, ContinueActions>): ReactElement {
  const progressId = useId();
  return (
    <section>
      <label htmlFor={progressId}>{props.label ?? 'Progress'}</label>
      <progress id={progressId} value={props.current} max={props.total} />
      <p>
        {props.current} / {props.total}
      </p>
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

export const Progress: ComponentEntry<ProgressProps, ContinueActions, 'education.Progress/v1'> =
  defineComponent({
    id: 'education.Progress/v1',
    props: propsSchema,
    actions: continueActions,
    component: ProgressView,
  });
