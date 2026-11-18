// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { z } from 'zod';

z.config({ jitless: true });
const { ensureAdkRuntimeEnv } = await import('@galaxie-ai/adapter-adk');
ensureAdkRuntimeEnv();
