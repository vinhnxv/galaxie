// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type ActionDefinition,
  type ComponentEntry,
  type ComponentProps,
  createRegistry,
  defineComponent,
  type Registry,
} from '@galaxie/react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import {
  type ReviewPassagesProps,
  ReviewPassagesSchema,
  type ReviewSubmission,
  ReviewSubmissionSchema,
} from '../agent/schemas.js';

type ReviewActions = { submit: ActionDefinition<ReviewSubmission> };
const actions: ReviewActions = {
  submit: { label: 'Answer with kept passages', payload: ReviewSubmissionSchema },
};
function ReviewPassagesView({
  props,
  actions,
  status,
}: ComponentProps<ReviewPassagesProps, ReviewActions>): ReactElement {
  const [keptIds, setKeptIds] = useState(() => props.passages.map(({ id }) => id));
  const busy = status === 'submitting' || status === 'accepted';
  const rejected = typeof status === 'object';
  const previous = useRef(rejected);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (rejected && !previous.current) alert.current?.focus();
    previous.current = rejected;
  }, [rejected]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void actions.submit.submit({ keptIds });
      }}
    >
      <fieldset disabled={busy}>
        <legend>Review retrieved passages</legend>
        {props.passages.length === 0 && (
          <p>No passages matched. You can answer without passages.</p>
        )}
        {props.passages.map(({ id, title }) => (
          <label key={id}>
            <input
              type="checkbox"
              checked={keptIds.includes(id)}
              onChange={(event) =>
                setKeptIds((current) =>
                  event.target.checked ? [...current, id] : current.filter((value) => value !== id),
                )
              }
            />
            {title} ({id})
          </label>
        ))}
        <button type="submit">{actions.submit.label}</button>
      </fieldset>
      {rejected && (
        <p role="alert" tabIndex={-1} ref={alert}>
          The review could not be submitted. Try again.
        </p>
      )}
    </form>
  );
}
export const ReviewPassages: ComponentEntry<
  ReviewPassagesProps,
  ReviewActions,
  'rag.ReviewPassages/v1'
> = defineComponent({
  id: 'rag.ReviewPassages/v1',
  props: ReviewPassagesSchema,
  actions,
  component: ReviewPassagesView,
});
export const reviewRegistry: Registry = createRegistry({ components: [ReviewPassages] });
