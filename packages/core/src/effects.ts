// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Transitions } from './lifecycle.js';

/** States of an external effect in the journal (brief §12.3). */
export type EffectState = 'planned' | 'dispatched' | 'succeeded' | 'failed' | 'outcome_unknown';

/**
 * Effect transitions. `planned` can fail without a dispatch, for example after a cancel. An
 * `outcome_unknown` effect is reconciled, or dispatched again with the same effect ID only when its
 * retry policy allows it; a non-idempotent effect is never fired again silently (brief §12.3).
 */
export const EFFECT_TRANSITIONS: Transitions<EffectState> = {
  planned: ['dispatched', 'failed'],
  dispatched: ['succeeded', 'failed', 'outcome_unknown'],
  outcome_unknown: ['dispatched', 'succeeded', 'failed'],
  succeeded: [],
  failed: [],
};
