// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Mirrors `examples/*/src/zod-config.ts`. The ADK web bundle inlines its own zod and reads the
// shared `globalThis.__zod_globalConfig` object when its module is evaluated, so this module must
// be evaluated before the first import of `@google/adk` (ADR-0020). A package marked
// `sideEffects: false` would let the bundler drop this import, so the probe page keeps it in a
// directory with its own package.json.
import { config } from 'zod';

config({ jitless: true });
