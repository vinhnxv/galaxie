// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';
import { ensureAdkRuntimeEnv } from '../../../../packages/adapter-adk/src/runtime-shim.js';

z.config({ jitless: true });
ensureAdkRuntimeEnv();
