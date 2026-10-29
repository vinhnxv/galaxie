// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  CapabilityBinding,
  CapabilityContext,
  CapabilityName,
  DestinationClass,
} from '@galaxie/core';
import { failure, type McpEvent } from './events.js';
import { PrincipalSession } from './session.js';

export interface McpLimits {
  readonly messageBytes?: number;
  readonly resultBytes?: number;
  readonly idleMs?: number;
}
export interface McpServerOptions {
  readonly id: string;
  readonly url: string;
  readonly destination: DestinationClass;
  readonly token: (request: {
    readonly principalScope: string;
    readonly signal: AbortSignal;
  }) => string | Promise<string>;
  readonly limits?: McpLimits;
  readonly fetch?: typeof globalThis.fetch;
  readonly onEvent?: (event: McpEvent) => void;
}
export interface McpToolBinding
  extends Pick<
    CapabilityBinding,
    'kind' | 'timeoutMs' | 'concurrency' | 'grantScope' | 'retry' | 'approval'
  > {
  readonly version: number;
  readonly pin: string;
  readonly result?: 'structured' | 'text';
}
export interface McpServer {
  bindings(
    tools: Readonly<Record<string, McpToolBinding>>,
  ): Record<CapabilityName, CapabilityBinding>;
  closePrincipal(principalScope: string): Promise<void>;
  close(): Promise<void>;
}
export interface SessionOptions extends McpServerOptions {
  readonly limits: Required<McpLimits>;
  emit(event: Omit<McpEvent, 'server'>): void;
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Host configuration only. Remote metadata never becomes a capability schema or policy. */
export function createMcpServer(supplied: McpServerOptions): McpServer {
  let url: URL;
  try {
    url = new URL(supplied.url);
  } catch {
    throw failure('invalid');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const limits = {
    messageBytes: supplied.limits?.messageBytes ?? 262144,
    resultBytes: supplied.limits?.resultBytes ?? 65536,
    idleMs: supplied.limits?.idleMs ?? 30000,
  };
  if (
    typeof supplied.id !== 'string' ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(supplied.id) ||
    typeof supplied.url !== 'string' ||
    url.username !== '' ||
    url.password !== '' ||
    /[?#]/.test(supplied.url) ||
    !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) ||
    !['user-device', 'user-endpoint', 'host-server', 'third-party'].includes(
      supplied.destination,
    ) ||
    (supplied.destination === 'user-device' && !loopback) ||
    typeof supplied.token !== 'function' ||
    (supplied.fetch !== undefined && typeof supplied.fetch !== 'function') ||
    (supplied.onEvent !== undefined && typeof supplied.onEvent !== 'function') ||
    !Object.values(limits).every(positive)
  )
    throw failure('invalid');
  const options: SessionOptions = {
    ...supplied,
    url: url.href,
    limits: Object.freeze(limits),
    emit(event): void {
      try {
        supplied.onEvent?.(Object.freeze({ ...event, server: supplied.id }));
      } catch {}
    },
  };
  const entries = new Map<string, McpToolBinding>();
  const sessions = new Map<string, PrincipalSession>();
  let closed = false;
  const closePrincipal = async (principalScope: string): Promise<void> => {
    const session = sessions.get(principalScope);
    sessions.delete(principalScope);
    await session?.close();
  };
  return {
    bindings(tools): Record<CapabilityName, CapabilityBinding> {
      if (closed || tools === null || typeof tools !== 'object' || Array.isArray(tools))
        throw failure('invalid');
      const bindings = Object.create(null) as Record<CapabilityName, CapabilityBinding>;
      for (const [tool, entry] of Object.entries(tools)) {
        if (
          !/^[A-Za-z0-9_.-]{1,128}$/.test(tool) ||
          entry === null ||
          typeof entry !== 'object' ||
          !positive(entry.version) ||
          !/^[a-f0-9]{64}$/.test(entry.pin) ||
          !['read', 'write'].includes(entry.kind) ||
          !positive(entry.timeoutMs) ||
          !positive(entry.concurrency) ||
          !['app', 'principal', 'instance', 'run'].includes(entry.grantScope) ||
          !['none', 'idempotent', 'idempotency-key'].includes(entry.retry) ||
          !['none', 'confirm'].includes(entry.approval) ||
          (entry.kind === 'write' && entry.approval !== 'confirm') ||
          (entry.result !== undefined && !['structured', 'text'].includes(entry.result))
        )
          throw failure('invalid');
        const configured = Object.freeze({ ...entry });
        entries.set(tool, configured);
        bindings[`mcp.${options.id}.${tool}@${entry.version}`] = Object.freeze({
          kind: configured.kind,
          destination: options.destination,
          timeoutMs: configured.timeoutMs,
          concurrency: configured.concurrency,
          grantScope: configured.grantScope,
          retry: configured.retry,
          approval: configured.approval,
          invoke: async (input: unknown, context: CapabilityContext): Promise<unknown> => {
            if (closed) throw failure();
            let session = sessions.get(context.principalScope);
            if (session === undefined) {
              session = new PrincipalSession(options, context.principalScope, entries);
              sessions.set(context.principalScope, session);
            }
            return session.invoke(tool, configured, input, context);
          },
        });
      }
      return bindings;
    },
    closePrincipal,
    async close(): Promise<void> {
      closed = true;
      await Promise.all([...sessions.keys()].map(closePrincipal));
    },
  };
}
