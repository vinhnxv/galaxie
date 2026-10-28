// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConformanceCase } from '../support/transcript.js';
import * as branching from './branching.js';
import * as capability from './capability.js';
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
  'step-limit',
] = [
  'linear',
  'branching',
  'subgraph',
  'model-without-config',
  'model-failure',
  'capability',
  'step-limit',
];
export type CaseName = (typeof CASE_NAMES)[number];
export const cases: Record<CaseName, ConformanceCase> = {
  linear,
  capability,
  'step-limit': stepLimit,
  branching,
  subgraph,
  'model-without-config': modelWithoutConfig,
  'model-failure': modelFailure,
};
