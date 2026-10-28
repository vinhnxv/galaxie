// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { GalaxieError, toErrorInfo } from './errors.js';
import { type BudgetLimits, DEFAULT_BUDGETS } from './policy.js';

export class BudgetExceeded extends GalaxieError {
  readonly budget: keyof BudgetLimits;
  constructor(budget: keyof BudgetLimits) {
    super('budget_exceeded', toErrorInfo('budget_exceeded').message);
    this.budget = budget;
  }
}

export function budgetLimits(overrides: Partial<BudgetLimits> = {}): BudgetLimits {
  const limits = { ...DEFAULT_BUDGETS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (
      !Object.hasOwn(DEFAULT_BUDGETS, name) ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      (name !== 'cost' && name !== 'wallClockMs' && !Number.isInteger(value)) ||
      (name === 'steps' && value < 1)
    )
      throw new GalaxieError('invalid', 'The budget limits are invalid.');
  }
  return Object.freeze(limits);
}

/** One model reservation, released before dispatch or replaced with a charge (ADR-0006). */
export interface ModelReservation {
  release(): void;
  settle(tokens: number, cost: number): void;
}

/** Per-run accounting. The instance owns terminal transitions and the wall-clock timer. */
export class RunBudget {
  readonly limits: BudgetLimits;
  #toolCalls = 0;
  readonly #committed = { tokens: 0, cost: 0 };
  readonly #reservations = new Set<{ readonly tokens: number; readonly cost: number }>();
  constructor(limits: BudgetLimits) {
    this.limits = limits;
  }
  reserveToolCall(): void {
    if (this.#toolCalls >= this.limits.toolCalls) throw new BudgetExceeded('toolCalls');
    this.#toolCalls++;
  }
  /** Reserve both dimensions atomically; token exhaustion takes precedence (ADR-0006). */
  reserveModel(tokens: number, cost: number): ModelReservation {
    const amounts = { tokens, cost };
    for (const name of ['tokens', 'cost'] as const) {
      let reserved = 0;
      for (const reservation of this.#reservations) reserved += reservation[name];
      if (this.#committed[name] + reserved + amounts[name] > this.limits[name])
        throw new BudgetExceeded(name);
    }
    this.#reservations.add(amounts);
    let open = true;
    const release = (): void => {
      if (!open) return;
      open = false;
      this.#reservations.delete(amounts);
    };
    return {
      release,
      settle: (chargedTokens, chargedCost) => {
        if (!open) return;
        release();
        this.#committed.tokens += chargedTokens;
        this.#committed.cost += chargedCost;
        for (const name of ['tokens', 'cost'] as const)
          if (this.#committed[name] > this.limits[name]) throw new BudgetExceeded(name);
      },
    };
  }
  payload(value: unknown): void {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      throw new GalaxieError('invalid', toErrorInfo('invalid').message);
    }
    if (json === undefined) throw new GalaxieError('invalid', toErrorInfo('invalid').message);
    if (new TextEncoder().encode(json).byteLength > this.limits.payloadBytes)
      throw new BudgetExceeded('payloadBytes');
  }
}

/** Browsers and Node cap a single timer delay at a signed 32-bit millisecond value. */
export function deadlineTimer(duration: number, expired: () => void): () => void {
  const deadline = performance.now() + duration;
  let timer: ReturnType<typeof setTimeout>;
  const arm = (): void => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      expired();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, 2147483647));
  };
  timer = setTimeout(arm, Math.min(duration, 2147483647));
  return () => clearTimeout(timer);
}
