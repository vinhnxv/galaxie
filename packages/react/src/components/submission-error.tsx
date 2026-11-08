// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ErrorCode } from '@galaxie-ai/core';
import type { ReactElement } from 'react';
import type { InteractionStatus } from '../registry.js';
import { useAlertFocus } from './alert-focus.js';

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
  const alert = useAlertFocus(rejected);
  return typeof status === 'string' ? null : (
    <p id={id} role="alert" tabIndex={-1} ref={alert}>
      {messages[status.rejected] ?? 'Your answer could not be sent. Try again.'}
    </p>
  );
}
