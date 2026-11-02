// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

const CAPTURE_FLAG = 'ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS';

/**
 * Makes the one `process` read the ADK web bundle performs unguarded safe, and keeps ADK span
 * content capture off (ADR-0020).
 *
 * When a tracer is registered, the bundle reads `process.env` without a `typeof` guard while it
 * records span attributes, and its content flag defaults to capturing prompts, replies,
 * arguments and results. Without a `process` global that read throws, and ADK turns the throw
 * into an ordinary error event. This creates a frozen `{ env }` holding only the flag. Where a
 * `process` already exists, it sets only the flag, and only when the key is unset. No real
 * environment data is read or exposed.
 *
 * It cannot reach a bundle whose bundler already replaced `process.env` with `{}` (Vite
 * production builds do): those hosts set the flag with a build-time define instead.
 */
export function ensureAdkRuntimeEnv(scope: object = globalThis): void {
  const existing: unknown = Reflect.get(scope, 'process');
  if (existing === undefined || existing === null) {
    Object.defineProperty(scope, 'process', {
      value: Object.freeze({ env: Object.freeze({ [CAPTURE_FLAG]: 'false' }) }),
      configurable: true,
      enumerable: false,
      writable: false,
    });
    return;
  }
  const env: unknown = Reflect.get(existing, 'env');
  if (typeof env === 'object' && env !== null && Reflect.get(env, CAPTURE_FLAG) === undefined)
    Reflect.set(env, CAPTURE_FLAG, 'false');
}
