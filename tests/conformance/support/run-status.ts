// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { RunSnapshot, RunStatus } from '@galaxie-ai/core';

interface ObservableRun {
  getSnapshot(): { readonly run?: Pick<RunSnapshot, 'status' | 'error'> };
  subscribe(listener: () => void): () => void;
}

export function waitForRunStatus(instance: ObservableRun, target: RunStatus): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = (): void => {
      const run = instance.getSnapshot().run;
      if (run?.status === target) {
        unsubscribe();
        resolve();
      } else if (
        run?.status === 'succeeded' ||
        run?.status === 'failed' ||
        run?.status === 'cancelled'
      ) {
        unsubscribe();
        reject(
          new Error(
            `Expected run status ${target}, observed ${run.status}${run.error === undefined ? '' : ` (${run.error.code})`}.`,
          ),
        );
      }
    };
    const unsubscribe = instance.subscribe(check);
    check();
  });
}
