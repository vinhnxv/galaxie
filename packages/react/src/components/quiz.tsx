// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type ReactElement, useId, useState } from 'react';
import { z } from 'zod';
import {
  type ActionDefinition,
  type ComponentEntry,
  type ComponentProps,
  defineComponent,
} from '../registry.js';
import { idSchema, longTextSchema, shortTextSchema, uniqueIds } from './schemas.js';
import { SubmissionError } from './submission-error.js';

export interface QuizOption {
  readonly id: string;
  readonly label: string;
}

export interface QuizQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly QuizOption[];
}

export interface QuizProps {
  readonly title?: string | undefined;
  readonly questions: readonly QuizQuestion[];
}

export interface QuizSubmission {
  readonly answers: Readonly<Record<string, string>>;
}

export type QuizActions = {
  readonly submit: ActionDefinition<QuizSubmission>;
};

const propsSchema = z.strictObject({
  title: shortTextSchema.optional(),
  questions: z
    .array(
      z.strictObject({
        id: idSchema,
        prompt: longTextSchema,
        options: z
          .array(z.strictObject({ id: idSchema, label: shortTextSchema }))
          .min(2)
          .max(6)
          .refine(uniqueIds),
      }),
    )
    .min(1)
    .max(20)
    .refine(uniqueIds),
});

const actions: QuizActions = {
  submit: {
    label: 'Submit answers',
    payload: z.strictObject({
      // Preserve IDs such as __proto__; a parsed Zod record omits that own key.
      answers: z.custom<Readonly<Record<string, string>>>((value: unknown) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        const keys = Reflect.ownKeys(value);
        return (
          keys.length >= 1 &&
          keys.length <= 20 &&
          keys.every(
            (key) =>
              typeof key === 'string' &&
              idSchema.safeParse(key).success &&
              idSchema.safeParse((value as Record<string, unknown>)[key]).success,
          )
        );
      }),
    }),
  },
};

function QuizView({
  props,
  actions,
  status,
}: ComponentProps<QuizProps, QuizActions>): ReactElement {
  const formId = useId();
  const [selected, setSelected] = useState<ReadonlyMap<string, string>>(() => new Map());
  const busy = status === 'submitting' || status === 'accepted';
  const complete = props.questions.every((question) =>
    question.options.some((option) => option.id === selected.get(question.id)),
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
        const answers = new Map<string, string>();
        for (const question of props.questions) {
          const choice = selected.get(question.id);
          if (choice === undefined || !question.options.some((option) => option.id === choice))
            return;
          answers.set(question.id, choice);
        }
        void actions.submit.submit({ answers: Object.fromEntries(answers) });
      }}
    >
      {props.title === undefined ? null : <h2>{props.title}</h2>}
      {props.questions.map((question) => (
        <fieldset key={question.id} disabled={busy}>
          <legend>{question.prompt}</legend>
          {question.options.map((option) => (
            <label key={option.id}>
              <input
                type="radio"
                name={`${formId}-${question.id}`}
                value={option.id}
                checked={selected.get(question.id) === option.id}
                onChange={() =>
                  setSelected((previous) => new Map(previous).set(question.id, option.id))
                }
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      ))}
      <SubmissionError id={`${formId}-error`} status={status} />
      <button
        type="submit"
        disabled={busy || !complete}
        aria-describedby={typeof status === 'object' ? `${formId}-error` : undefined}
      >
        {actions.submit.label}
      </button>
    </form>
  );
}

export const Quiz: ComponentEntry<QuizProps, QuizActions, 'education.Quiz/v1'> = defineComponent<
  QuizProps,
  QuizActions,
  'education.Quiz/v1'
>({
  id: 'education.Quiz/v1',
  props: propsSchema,
  actions,
  component: QuizView,
});
