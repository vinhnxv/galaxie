// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type ReactElement, useSyncExternalStore } from 'react';
import { type Instance, renderInteraction } from './registry.js';

export function Surface({
  instance,
  score,
}: {
  instance: Instance;
  score: number | undefined;
}): ReactElement {
  const { run } = useSyncExternalStore(instance.subscribe, instance.getSnapshot);
  if (!run || run.status === 'queued' || run.status === 'running')
    return (
      <p data-testid="working" data-code="working">
        Working
      </p>
    );
  if (run.status === 'waiting_input' && run.pending) {
    const rendered = renderInteraction(instance, run.pending);
    return rendered.ok ? (
      rendered.element
    ) : (
      <p data-testid="registry-error" data-code={rendered.error.code}>
        {rendered.error.message}
      </p>
    );
  }
  if (run.status === 'succeeded')
    return (
      <p data-testid="result" data-code="succeeded">
        Score: {score} / 3
      </p>
    );
  const code = run.error?.code ?? run.status;
  return (
    <p data-testid="run-error" data-code={code}>
      Run failed: {code}
    </p>
  );
}
