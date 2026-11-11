// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type BaseAgent, Runner, type Session } from '@google/adk';

/** Measurement only: change ADK routing, retaining the adapter's admission rule. */
export async function withResumableRunner<T>(
  run: (routed: () => number) => Promise<T>,
): Promise<T> {
  type Method = (this: Runner, session: Session, root: BaseAgent) => BaseAgent;
  const original = Reflect.get(Runner.prototype, 'determineAgentForResumption') as
    | Method
    | undefined;
  if (typeof original !== 'function') throw new Error('The ADK resumption seam is unavailable.');
  let calls = 0;
  Reflect.set(
    Runner.prototype,
    'determineAgentForResumption',
    function (this: Runner, session: Session, root: BaseAgent): BaseAgent {
      Reflect.set(this, 'resumabilityConfig', { isResumable: true });
      calls += 1;
      return original.call(this, session, root);
    },
  );
  try {
    return await run(() => calls);
  } finally {
    Reflect.set(Runner.prototype, 'determineAgentForResumption', original);
  }
}
