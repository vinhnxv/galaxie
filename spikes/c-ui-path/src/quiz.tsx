// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { PendingInteraction } from '@galaxie/core';
import { type ReactElement, useRef, useState } from 'react';
import { type Instance, type QuizProps, submit } from './registry.js';

export function Quiz({
  questions,
  instance,
  pending,
}: QuizProps & { instance: Instance; pending: PendingInteraction }): ReactElement {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);
  return (
    <form
      data-testid="quiz"
      onSubmit={async (event) => {
        event.preventDefault();
        if (inFlight.current) return;
        inFlight.current = true;
        setBusy(true);
        try {
          const receipt = await submit(instance, pending, 'submit', { answers });
          if (receipt.status === 'rejected') setError(receipt.error.code);
        } catch {
          setError('dispatch_failed');
        } finally {
          inFlight.current = false;
          setBusy(false);
        }
      }}
    >
      {questions.map((question) => (
        <fieldset key={question.id}>
          <legend>{question.prompt}</legend>
          {question.options.map((option, index) => (
            <label key={option} style={{ display: 'block' }}>
              <input
                type="radio"
                name={question.id}
                data-testid={`${question.id}-${index}`}
                value={option}
                checked={answers[question.id] === option}
                onChange={() => setAnswers({ ...answers, [question.id]: option })}
              />
              {option}
            </label>
          ))}
        </fieldset>
      ))}
      <button type="submit" disabled={busy}>
        Submit answers
      </button>
      {error && (
        <p data-testid="submit-error" data-code={error}>
          {error}
        </p>
      )}
    </form>
  );
}
