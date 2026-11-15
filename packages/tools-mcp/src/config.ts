// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type CapabilityBinding, type CapabilityName, GalaxieError } from '@galaxie-ai/core';
import {
  buildRuntimeLimits,
  HostConfigError,
  type ValidatedHostConfig,
} from '@galaxie-ai/core/config';
import type { McpEvent } from './events.js';
import { createMcpServer, type McpLimits, type McpServer, type McpToolBinding } from './server.js';

export interface BuildMcpServersOptions {
  readonly onEvent?: (event: McpEvent) => void;
}

export interface BuiltMcpServers {
  readonly bindings: Readonly<Record<CapabilityName, CapabilityBinding>>;
  readonly servers: Readonly<Record<string, McpServer>>;
}

/** Builds host-owned MCP wiring without invoking hooks or opening sessions. */
export function buildMcpServers(
  config: ValidatedHostConfig,
  options: BuildMcpServersOptions = {},
): BuiltMcpServers {
  // This core builder asserts the private validation brand before reading the document.
  buildRuntimeLimits(config);
  const bindings = Object.create(null) as Record<CapabilityName, CapabilityBinding>;
  const servers = Object.create(null) as Record<string, McpServer>;
  let path = '';
  try {
    for (const [name, server] of Object.entries(config.document.mcp?.servers ?? {})) {
      // Validated server and tool names contain neither '/' nor '~', so need no pointer escaping.
      path = `/mcp/servers/${name}`;
      const tokens = Object.hasOwn(config.hooks, 'token') ? config.hooks.token : undefined;
      const token =
        tokens !== undefined && Object.hasOwn(tokens, server.token)
          ? tokens[server.token]
          : undefined;
      if (typeof token !== 'function') throw new HostConfigError('invalid', `${path}/token`);
      const fetches = Object.hasOwn(config.hooks, 'fetch') ? config.hooks.fetch : undefined;
      const fetch =
        server.fetch !== undefined && fetches !== undefined && Object.hasOwn(fetches, server.fetch)
          ? fetches[server.fetch]
          : undefined;
      if (server.fetch !== undefined && typeof fetch !== 'function')
        throw new HostConfigError('invalid', `${path}/fetch`);
      const limits: McpLimits | undefined =
        server.limits === undefined
          ? undefined
          : {
              ...(server.limits.messageBytes === undefined
                ? {}
                : { messageBytes: server.limits.messageBytes }),
              ...(server.limits.resultBytes === undefined
                ? {}
                : { resultBytes: server.limits.resultBytes }),
              ...(server.limits.idleMs === undefined ? {} : { idleMs: server.limits.idleMs }),
            };
      const client = createMcpServer({
        id: name,
        url: server.url,
        destination: server.destination,
        token,
        ...(fetch === undefined ? {} : { fetch }),
        ...(server.propagateTraceContext === undefined
          ? {}
          : { propagateTraceContext: server.propagateTraceContext }),
        ...(limits === undefined ? {} : { limits }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      });
      servers[name] = client;
      for (const [tool, entry] of Object.entries(server.tools)) {
        path = `/mcp/servers/${name}/tools/${tool}`;
        const binding: McpToolBinding = {
          version: entry.version,
          pin: entry.pin,
          kind: entry.kind,
          timeoutMs: entry.timeoutMs,
          concurrency: entry.concurrency,
          grantScope: entry.grantScope,
          retry: entry.retry,
          approval: entry.approval,
          ...(entry.result === undefined ? {} : { result: entry.result }),
        };
        Object.assign(bindings, client.bindings({ [tool]: binding }));
      }
    }
  } catch (error) {
    // New servers have no sessions; close marks them closed synchronously before its promise settles.
    for (const server of Object.values(servers)) void server.close().catch(() => {});
    if (error instanceof HostConfigError) throw error;
    if (error instanceof GalaxieError) throw new HostConfigError(error.code, path, error);
    throw new HostConfigError('invalid', path);
  }
  return { bindings: Object.freeze(bindings), servers: Object.freeze(servers) };
}
