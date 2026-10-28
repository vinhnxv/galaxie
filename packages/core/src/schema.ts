// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { $ZodType, input, output } from 'zod/v4/core';

/** A Zod v4 schema, from `zod` or `zod/mini` (ADR-0008). */
export type Schema = $ZodType;

/** The value a schema produces once it has validated its input. */
export type Infer<S extends Schema> = output<S>;

/** The value a schema accepts before validation. */
export type InferInput<S extends Schema> = input<S>;
