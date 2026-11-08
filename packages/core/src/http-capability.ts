// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Annotations } from './annotations.js';
import { BudgetExceeded } from './budgets.js';
import {
  attributionHeaders,
  type CapabilityBinding,
  type CapabilityContext,
  type HttpCapabilityOptions,
} from './capabilities.js';
import { type ErrorCode, GalaxieError, toErrorInfo } from './errors.js';
import type { DestinationClass } from './policy.js';
import { DEFAULT_BUDGETS } from './policy.js';
import { isHttpDestination, isLoopback, isPrivateAddress } from './urls.js';

interface Placeholder {
  readonly name: string;
  readonly path: boolean;
}
interface Template {
  readonly origin: string;
  readonly segments: readonly string[];
  readonly dynamic: readonly boolean[];
  readonly placeholders: readonly Placeholder[];
}
export interface HttpDescriptor {
  validate(annotations: Annotations, binding: CapabilityBinding): void;
  invoke(
    input: unknown,
    context: CapabilityContext,
    payloadBytes: number,
    destination: DestinationClass,
  ): Promise<unknown>;
}
// The invoke identity also preserves the marker when a host shallow-copies a binding's policy.
const descriptors = new WeakMap<object, HttpDescriptor>();
export function getHttpCapability(binding: {
  readonly invoke: CapabilityBinding<never>['invoke'];
}): HttpDescriptor | undefined {
  return descriptors.get(binding.invoke);
}
function fail(code: ErrorCode): never {
  throw new GalaxieError(code, toErrorInfo(code).message);
}
function template(url: string): Template {
  if (typeof url !== 'string') fail('invalid');
  const authority = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url)?.[0];
  if (authority === undefined || /[{}]/.test(authority)) fail('invalid');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail('invalid');
  }
  if (!isHttpDestination(parsed)) fail('invalid');
  if (/[{}]/.test(parsed.hash)) fail('invalid');
  const queryStart = url.indexOf('?');
  const fragmentStart = url.indexOf('#');
  const pathEnd = Math.min(
    ...[queryStart, fragmentStart, url.length].filter((value) => value >= 0),
  );
  const rawPath = url.slice(authority.length, pathEnd);
  const rawQuery =
    queryStart < 0 ? '' : url.slice(queryStart + 1, fragmentStart < 0 ? undefined : fragmentStart);
  const placeholders: Placeholder[] = [];
  const add = (text: string, path: boolean): void => {
    const remaining = text.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
      placeholders.push({ name, path });
      return '';
    });
    if (/[{}]/.test(remaining)) fail('invalid');
  };
  add(rawPath, true);
  for (const pair of rawQuery.split('&')) {
    const equals = pair.indexOf('=');
    if (/[{}]/.test(equals < 0 ? pair : pair.slice(0, equals))) fail('invalid');
    if (equals >= 0) add(pair.slice(equals + 1), false);
  }
  const segments = parsed.pathname.split('/');
  return {
    origin: parsed.origin,
    segments,
    dynamic: segments.map((segment) => /%7B[^/]*%7D/i.test(segment)),
    placeholders,
  };
}
function filledUrl(url: string, compiled: Template, input: Record<string, unknown>): string {
  for (const placeholder of compiled.placeholders) {
    if (!Object.hasOwn(input, placeholder.name)) fail('invalid');
    const value = input[placeholder.name];
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean' &&
      value !== null
    )
      fail('invalid');
    if (placeholder.path) {
      let decoded = String(value);
      try {
        decoded = decodeURIComponent(decoded);
      } catch {
        /* A literal percent is encoded below. */
      }
      if (['', '.', '..'].includes(decoded.toLowerCase())) fail('denied');
    }
  }
  const filled = url.replace(/\{([^{}]+)\}/g, (_match, name: string) =>
    encodeURIComponent(String(input[name])),
  );
  let parsed: URL;
  try {
    parsed = new URL(filled);
  } catch {
    return fail('denied');
  }
  const segments = parsed.pathname.split('/');
  if (
    parsed.origin !== compiled.origin ||
    segments.length !== compiled.segments.length ||
    segments.some(
      (segment, index) => !compiled.dynamic[index] && segment !== compiled.segments[index],
    )
  )
    fail('denied');
  return parsed.href;
}
async function readBody(response: Response, cap: number): Promise<string> {
  if (response.body === null) {
    const body = await response.arrayBuffer();
    if (body.byteLength > cap) throw new BudgetExceeded('payloadBytes');
    return new TextDecoder().decode(body);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > cap) {
        // Do not let a producer that ignores cancellation hold up the budget rejection.
        void reader.cancel().catch(() => {});
        throw new BudgetExceeded('payloadBytes');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** Host-literal HTTP binding. Cross-origin servers must allow both X-Galaxie attribution headers
 * in Access-Control-Allow-Headers, plus Idempotency-Key when retry is 'idempotency-key'. A failed
 * preflight fails with unreachable for user-device or local/private user-endpoint destinations,
 * and with unavailable for other destinations, following the existing network error rule.
 * Headers never authorize. */
export function httpCapability<Input = unknown, Output = unknown>(
  supplied: HttpCapabilityOptions,
): CapabilityBinding<Input, Output> {
  const options = Object.freeze({ ...supplied });
  const compiled = template(options.url);
  const hostname = new URL(compiled.origin).hostname;
  const validateDestination = (binding: Pick<CapabilityBinding, 'destination'>): void => {
    if (
      binding.destination === 'in-browser' ||
      (binding.destination === 'user-device' && !isLoopback(new URL(compiled.origin).hostname))
    )
      fail('invalid');
  };
  validateDestination(options);
  if (!['GET', 'DELETE', 'POST', 'PUT', 'PATCH'].includes(options.method)) fail('invalid');
  const descriptor: HttpDescriptor = {
    validate(annotations, binding): void {
      validateDestination(binding);
      for (const placeholder of compiled.placeholders) {
        if (
          !annotations.properties.has(placeholder.name) ||
          (placeholder.path && annotations.properties.get(placeholder.name) === 'freeText')
        )
          fail('invalid');
      }
    },
    async invoke(value, context, cap, destination): Promise<unknown> {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('invalid');
      const input = value as Record<string, unknown>;
      const url = filledUrl(options.url, compiled, input);
      const headers = new Headers(await options.headers?.(context));
      const hasBody = ['POST', 'PUT', 'PATCH'].includes(options.method);
      const used = new Set(compiled.placeholders.map((placeholder) => placeholder.name));
      const body = hasBody
        ? JSON.stringify(
            Object.fromEntries(Object.entries(input).filter(([key]) => !used.has(key))),
          )
        : undefined;
      if (hasBody) headers.set('content-type', 'application/json');
      for (const [key, value] of Object.entries(attributionHeaders(context)))
        headers.set(key, value);
      if (options.retry === 'idempotency-key') headers.set('Idempotency-Key', context.effectId);
      if (context.signal.aborted) fail('cancelled');
      let response: Response;
      try {
        response = await (options.fetch ?? globalThis.fetch)(url, {
          method: options.method,
          headers,
          credentials: options.credentials ?? 'same-origin',
          redirect: 'error',
          signal: context.signal,
          ...(body === undefined ? {} : { body }),
        });
      } catch (error) {
        if (context.signal.aborted) return fail('cancelled');
        if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
          return fail('unavailable');
        return fail(
          destination === 'user-device' ||
            (destination === 'user-endpoint' &&
              (isLoopback(hostname) || isPrivateAddress(hostname)))
            ? 'unreachable'
            : 'unavailable',
        );
      }
      if (response.status === 401 || response.status === 403) fail('denied');
      if (response.status >= 400 && response.status < 500) fail('invalid');
      if (response.status < 200 || response.status >= 300) fail('unavailable');
      const text = await readBody(response, cap);
      if ((response.status === 204 || response.status === 205) && text === '') return null;
      if (
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
      )
        fail('invalid');
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return fail('invalid');
      }
    },
  };
  const binding: CapabilityBinding<Input, Output> = Object.freeze({
    kind: options.kind,
    destination: options.destination,
    timeoutMs: options.timeoutMs,
    concurrency: options.concurrency,
    grantScope: options.grantScope,
    approval: options.approval,
    retry: options.retry,
    ...(options.reconcile === undefined ? {} : { reconcile: options.reconcile }),
    invoke: async (input: Input, context: CapabilityContext): Promise<Output> =>
      (await descriptor.invoke(
        input,
        context,
        DEFAULT_BUDGETS.payloadBytes,
        options.destination,
      )) as Output,
  });
  descriptors.set(binding.invoke, descriptor);
  return binding;
}
