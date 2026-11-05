// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Import this first in any test that loads `@google/adk`: zod must be jitless and the runtime
// environment safe before the bundle module is evaluated (ADR-0020).
import './bundle-csp/jitless.js';
import { ensureAdkRuntimeEnv } from '../../src/runtime-shim.js';

ensureAdkRuntimeEnv();
