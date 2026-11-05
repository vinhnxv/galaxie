// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { ConformanceCase, ConformanceGraph } from '../support/transcript.js';
import { createGraph } from './interrupt-resume.js';

export { input, resumes, script } from './interrupt-resume.js';

export function factory(...args: Parameters<ConformanceCase['factory']>): ConformanceGraph {
  return createGraph(args, 'exit');
}
