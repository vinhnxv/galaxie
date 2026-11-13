// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { LlmAgent } from '@google/adk';
import type { AdkAgent } from '../../src/index.js';

export const modelBefore: AdkAgent = () =>
  new LlmAgent({ name: 'root', model: 'gemini-2.5-flash' });
