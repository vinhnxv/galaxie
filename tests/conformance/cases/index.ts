// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConformanceCase } from '../support/transcript.js';
import * as branching from './branching.js';
import * as capability from './capability.js';
import * as interruptDurabilityExit from './interrupt-durability-exit.js';
import * as interruptDurabilitySync from './interrupt-durability-sync.js';
import * as interruptResume from './interrupt-resume.js';
import * as interruptSequence from './interrupt-sequence.js';
import * as interruptSubgraph from './interrupt-subgraph.js';
import * as linear from './linear.js';
import * as modelFailure from './model-failure.js';
import * as modelWithoutConfig from './model-without-config.js';
import * as stepLimit from './step-limit.js';
import * as subgraph from './subgraph.js';

export const CASE_NAMES: readonly [
  'linear',
  'branching',
  'subgraph',
  'model-without-config',
  'model-failure',
  'capability',
  'interrupt-resume',
  'interrupt-sequence',
  'interrupt-subgraph',
  'interrupt-durability-sync',
  'interrupt-durability-exit',
  'step-limit',
] = [
  'linear',
  'branching',
  'subgraph',
  'model-without-config',
  'model-failure',
  'capability',
  'interrupt-resume',
  'interrupt-sequence',
  'interrupt-subgraph',
  'interrupt-durability-sync',
  'interrupt-durability-exit',
  'step-limit',
];
export type CaseName = (typeof CASE_NAMES)[number];
export const cases: Record<CaseName, ConformanceCase> = {
  'interrupt-durability-exit': interruptDurabilityExit,
  'interrupt-durability-sync': interruptDurabilitySync,
  'interrupt-subgraph': interruptSubgraph,
  'interrupt-sequence': interruptSequence,
  'interrupt-resume': interruptResume,
  linear,
  capability,
  'step-limit': stepLimit,
  branching,
  subgraph,
  'model-without-config': modelWithoutConfig,
  'model-failure': modelFailure,
};
