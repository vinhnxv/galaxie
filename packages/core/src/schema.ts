// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { $ZodType, input, output } from 'zod/v4/core';

/** A Zod v4 schema, from `zod` or `zod/mini` (ADR-0008). */
export type Schema = $ZodType;

/** The value a schema produces once it has validated its input. */
export type Infer<S extends Schema> = output<S>;

/** The value a schema accepts before validation. */
export type InferInput<S extends Schema> = input<S>;

/** Standard Schema v1 validation contract for framework-neutral UI props and actions. */
export interface StandardSchema<Output = unknown, Input = Output> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    /** Type-only metadata from the Standard Schema spec; never read at runtime. */
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: readonly unknown[] }
      | Promise<
          | { readonly value: Output; readonly issues?: undefined }
          | { readonly issues: readonly unknown[] }
        >;
  };
}

/** Checks the protocol without running host validation code. */
export function isStandardSchema(value: unknown): value is StandardSchema {
  if (value === null || typeof value !== 'object' || !('~standard' in value)) return false;
  const standard = value['~standard'];
  return (
    standard !== null &&
    typeof standard === 'object' &&
    'version' in standard &&
    standard.version === 1 &&
    'vendor' in standard &&
    typeof standard.vendor === 'string' &&
    'validate' in standard &&
    typeof standard.validate === 'function'
  );
}

/**
 * Rejects asynchronous validators and discards all schema issues and thrown values.
 * Schemas must validate synchronously. Zod 4.6.7 runs an async refinement and drops its Promise
 * before reporting async use, so a rejecting refinement still surfaces as an unhandled rejection
 * carrying the refinement's own error; the validation result is `{ ok: false }` regardless.
 */
export function validateSync<Output>(
  schema: StandardSchema<Output>,
  value: unknown,
): { readonly ok: true; readonly value: Output } | { readonly ok: false } {
  try {
    const result = schema['~standard'].validate(value);
    if ('then' in result && typeof result.then === 'function') {
      // A rejected async validator must not become an unhandled rejection.
      void Promise.resolve(result).catch(() => {});
      return { ok: false };
    }
    if ('issues' in result && result.issues !== undefined) return { ok: false };
    if ('value' in result) return { ok: true, value: result.value };
  } catch {}
  return { ok: false };
}
