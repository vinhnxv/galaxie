// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ConformanceCase } from '../support/transcript.js';
import * as gateContinue from './gate-continue.js';
import * as gateReject from './gate-reject.js';

export const GATE_CASE_NAMES = ['gate-continue', 'gate-reject'] as const;
export const gateCases: Readonly<Record<(typeof GATE_CASE_NAMES)[number], ConformanceCase>> = {
  'gate-continue': gateContinue,
  'gate-reject': gateReject,
};
