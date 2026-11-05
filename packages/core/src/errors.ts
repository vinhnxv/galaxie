// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/**
 * Error codes. Each one names a documented outcome:
 *
 * - `invalid`: a schema rejected data, or a call was made in the wrong state.
 * - `denied`: policy refused the call: an ungranted capability, or a data label or destination
 *   class that is not allowed (ADR-0014).
 * - `unavailable`: no provider in the role's list can serve the call (ADR-0006).
 * - `unreachable`: a `localhost` or LAN endpoint did not answer. A Local Network Access denial, a
 *   CORS failure and a stopped server look the same to page code, so the message lists the likely
 *   causes (brief §10.4).
 * - `unsupported`: the executor or runtime cannot do this, for example simultaneous interrupts
 *   (ADR-0004).
 * - `budget_exceeded`: a budget limit was reached (brief §9.4).
 * - `timeout`: a call ran past its timeout (brief §9.2).
 * - `stale`: the event targets another instance, run, surface, interaction or revision (brief §11.4).
 * - `duplicate`: the interaction already has an accepted submission (ADR-0004).
 * - `fenced`: another tab owns the runtime, so a write with a stale epoch was refused (ADR-0009).
 * - `cancelled`: the run or the call was cancelled.
 * - `unrecoverable`: stored state cannot be read or migrated (brief §12.4).
 * - `outcome_unknown`: a previous write may have reached its destination and cannot be retried.
 * - `executor_error`: the executor or agent code failed.
 */
export type ErrorCode =
  | 'invalid'
  | 'denied'
  | 'unavailable'
  | 'unreachable'
  | 'unsupported'
  | 'budget_exceeded'
  | 'timeout'
  | 'stale'
  | 'duplicate'
  | 'fenced'
  | 'cancelled'
  | 'unrecoverable'
  | 'outcome_unknown'
  | 'executor_error';

/**
 * Error data that can be journaled and passed between execution contexts. Messages never contain
 * user content or credentials (ADR-0012 A4).
 */
export interface ErrorInfo {
  readonly code: ErrorCode;
  readonly message: string;
  readonly type?: string;
}

const ERROR_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  invalid: 'The request is invalid.',
  denied: 'Policy denied the request.',
  unavailable: 'The requested service is unavailable.',
  unreachable:
    'The endpoint did not answer. Local Network Access may be denied, CORS may not allow this app origin (for example OLLAMA_ORIGINS), or the server may be stopped.',
  unsupported: 'This operation is unsupported.',
  budget_exceeded: 'The budget limit was reached.',
  timeout: 'The operation timed out.',
  stale: 'The request targets stale state.',
  duplicate: 'The submission was already accepted.',
  fenced: 'Another owner controls the runtime.',
  cancelled: 'The operation was cancelled.',
  unrecoverable: 'Stored state cannot be recovered.',
  outcome_unknown: 'The outcome of an earlier call is unknown.',
  executor_error: 'The executor or agent code failed.',
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(ERROR_MESSAGES, value);
}

/** Recognizes errors across realms without trusting their message. */
export function isGalaxieError(value: unknown): value is GalaxieError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    value.name === 'GalaxieError' &&
    'code' in value &&
    isErrorCode(value.code)
  );
}

/** Creates content-free stored error data (ADR-0012 A4). */
export function toErrorInfo(code: ErrorCode, error?: unknown): ErrorInfo {
  if (error === undefined) return { code, message: ERROR_MESSAGES[code] };
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
  const type =
    typeof name === 'string' && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(name) ? name : 'Error';
  return { code, message: ERROR_MESSAGES[code], type };
}

/** The error galaxie APIs throw or reject with. */
export class GalaxieError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GalaxieError';
    this.code = code;
  }
}
