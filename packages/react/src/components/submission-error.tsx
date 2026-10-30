// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ErrorCode } from '@galaxie/core';
import { type ReactElement, useEffect, useRef } from 'react';
import type { InteractionStatus } from '../registry.js';

const messages: Readonly<Partial<Record<ErrorCode, string>>> = {
  invalid: 'Check your answer and try again.',
  duplicate: 'This answer was already sent.',
  stale: 'This question is no longer active.',
};

export function SubmissionError({
  status,
  id,
}: {
  readonly status: InteractionStatus;
  readonly id: string;
}): ReactElement | null {
  const rejected = typeof status === 'object';
  const wasRejected = useRef(rejected);
  const alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (rejected && !wasRejected.current) alert.current?.focus();
    wasRejected.current = rejected;
  }, [rejected]);
  return typeof status === 'string' ? null : (
    <p id={id} role="alert" tabIndex={-1} ref={alert}>
      {messages[status.rejected] ?? 'Your answer could not be sent. Try again.'}
    </p>
  );
}
