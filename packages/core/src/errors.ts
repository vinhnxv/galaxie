// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Error codes. Each one names a documented outcome:
 *
 * - `invalid`: a schema rejected a request, a response, props or an event.
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
  | 'unrecoverable';

/**
 * Error data that can be journaled and passed between execution contexts. Messages never contain
 * user content or credentials (ADR-0012 A4).
 */
export interface ErrorInfo {
  readonly code: ErrorCode;
  readonly message: string;
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
