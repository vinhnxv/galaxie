// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { galaxieField } from '@galaxie-ai/core';
import { type ReactElement, useId, useState } from 'react';
import { z } from 'zod';
import {
  type ActionDefinition,
  type ComponentEntry,
  type ComponentProps,
  defineComponent,
} from '../registry.js';
import { longTextSchema, shortTextSchema } from './schemas.js';
import { SubmissionError } from './submission-error.js';

export interface WritingPromptProps {
  readonly title?: string | undefined;
  readonly prompt: string;
  readonly placeholder?: string | undefined;
  readonly maxLength?: number | undefined;
}

export interface WritingSubmission {
  readonly sentence: string;
}

export type WritingPromptActions = {
  readonly submit: ActionDefinition<WritingSubmission>;
};

const propsSchema = z.strictObject({
  title: shortTextSchema.optional(),
  prompt: longTextSchema,
  placeholder: shortTextSchema.optional(),
  maxLength: z.number().int().min(1).max(500).default(500),
});

const actions: WritingPromptActions = {
  submit: {
    label: 'Submit sentence',
    payload: z.strictObject({
      sentence: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .meta(galaxieField({ label: 'private-user', shape: 'freeText' })),
    }),
  },
};

function WritingPromptView({
  props,
  actions,
  status,
}: ComponentProps<WritingPromptProps, WritingPromptActions>): ReactElement {
  const inputId = useId();
  const [draft, setDraft] = useState('');
  const busy = status === 'submitting' || status === 'accepted';
  const sentence = draft.trim();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && sentence.length > 0) void actions.submit.submit({ sentence });
      }}
    >
      {props.title === undefined ? null : <h2>{props.title}</h2>}
      <label htmlFor={inputId}>{props.prompt}</label>
      <textarea
        id={inputId}
        value={draft}
        placeholder={props.placeholder}
        maxLength={props.maxLength ?? 500}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
      />
      <SubmissionError id={`${inputId}-error`} status={status} />
      <button
        type="submit"
        disabled={busy || sentence.length === 0}
        aria-describedby={typeof status === 'object' ? `${inputId}-error` : undefined}
      >
        {actions.submit.label}
      </button>
    </form>
  );
}

export const WritingPrompt: ComponentEntry<
  WritingPromptProps,
  WritingPromptActions,
  'education.WritingPrompt/v1'
> = defineComponent<WritingPromptProps, WritingPromptActions, 'education.WritingPrompt/v1'>({
  id: 'education.WritingPrompt/v1',
  props: propsSchema,
  actions,
  component: WritingPromptView,
});
