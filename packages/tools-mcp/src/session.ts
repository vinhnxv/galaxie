// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type CapabilityContext, GalaxieError } from '@galaxie/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  McpError,
  type Tool,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { canonical, toolPin } from './canonical.js';
import { failure } from './events.js';
import { WireLimits } from './limits.js';
import type { McpToolBinding, SessionOptions } from './server.js';

interface Connection {
  readonly client: Client;
  readonly limits: WireLimits;
  expired: boolean;
}

export class PrincipalSession {
  readonly #options: SessionOptions;
  readonly #principal: string;
  readonly #entries: ReadonlyMap<string, McpToolBinding>;
  readonly #lifetime = new AbortController();
  #tail: Promise<unknown> = Promise.resolve();
  #connection: Connection | undefined;
  #token = '';

  constructor(
    options: SessionOptions,
    principal: string,
    entries: ReadonlyMap<string, McpToolBinding>,
  ) {
    this.#options = options;
    this.#principal = principal;
    this.#entries = entries;
  }
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => {});
    return result;
  }
  async #credential(signal: AbortSignal): Promise<void> {
    try {
      const token = await this.#options.token({ principalScope: this.#principal, signal });
      if (typeof token !== 'string' || token.trim().length === 0) throw failure();
      this.#token = token;
    } catch {
      throw failure();
    }
  }
  async #connect(signal: AbortSignal, timeout: number): Promise<Connection> {
    await this.#credential(signal);
    const client = new Client({ name: 'galaxie', version: '0.0.0' }, { capabilities: {} });
    client.onerror = () => {};
    client.removeRequestHandler('ping');
    client.fallbackRequestHandler = async (request) => {
      this.#options.emit({ code: 'mcp_server_request_rejected', method: request.method });
      throw new McpError(-32601, 'Method not found');
    };
    const limits = new WireLimits(
      this.#options.limits.messageBytes,
      this.#options.limits.idleMs,
      () => this.#options.emit({ code: 'mcp_limit_exceeded' }),
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.#options.url), {
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 30000,
        reconnectionDelayGrowFactor: 1.5,
      },
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${this.#token}`);
        const response = await (this.#options.fetch ?? globalThis.fetch)(url, {
          ...init,
          headers,
          credentials: 'omit',
          redirect: 'error',
          signal: AbortSignal.any([
            ...(init?.signal === undefined || init.signal === null ? [] : [init.signal]),
            this.#lifetime.signal,
          ]),
        });
        if (response.status === 401 || response.status === 403)
          this.#options.emit({ code: 'mcp_unauthorized' });
        if (response.status === 404 && transport.sessionId !== undefined) connection.expired = true;
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          // SDK HTTP errors embed the response body; discard it before SDK error construction.
          return new Response(null, { status: response.status });
        }
        return limits.wrap(response, init?.method === 'POST');
      },
    });
    const connection: Connection = { client, limits, expired: false };
    this.#connection = connection;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      void this.#serialize(async () => {
        if (this.#connection !== connection || this.#lifetime.signal.aborted) return;
        await this.#list(
          connection,
          AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(timeout)]),
          timeout,
        );
      }).catch(() => {});
    });
    // SDK sessionId accessor includes undefined unlike Transport's optional property.
    await limits.request(signal, (requestSignal) =>
      client.connect(transport as Parameters<Client['connect']>[0], {
        signal: requestSignal,
        timeout,
      }),
    );
    if (transport.protocolVersion !== '2025-11-25') {
      this.#options.emit({ code: 'mcp_protocol_mismatch' });
      await this.#drop();
      throw failure();
    }
    await this.#list(connection, signal, timeout);
    return connection;
  }
  async #list(
    connection: Connection,
    signal: AbortSignal,
    timeout: number,
  ): Promise<Map<string, string>> {
    const tools = new Map<string, Tool>();
    let cursor: string | undefined;
    connection.limits.beginListing();
    try {
      for (let page = 0; page < 10; page++) {
        const result = await connection.limits.request(signal, (requestSignal) =>
          connection.client.request(
            { method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
            ListToolsResultSchema,
            { signal: requestSignal, timeout },
          ),
        );
        for (const tool of result.tools) {
          if (tools.has(tool.name)) throw failure();
          tools.set(tool.name, tool);
        }
        cursor = result.nextCursor;
        if (cursor === undefined) {
          const pins = new Map<string, string>();
          for (const [name, tool] of tools)
            if (this.#entries.has(name)) pins.set(name, await toolPin(tool));
          for (const [name, entry] of this.#entries) this.#pin(name, entry, pins);
          return pins;
        }
      }
      throw failure();
    } finally {
      connection.limits.endListing();
    }
  }
  #pin(name: string, entry: McpToolBinding, tools: ReadonlyMap<string, string>): boolean {
    const tool = tools.get(name);
    const valid = tool !== undefined && tool === entry.pin;
    if (!valid)
      this.#options.emit({
        code: tool === undefined ? 'mcp_tool_missing' : 'mcp_pin_mismatch',
        tool: name,
      });
    return valid;
  }
  async #drop(): Promise<void> {
    const connection = this.#connection;
    this.#connection = undefined;
    connection?.limits.close();
    await connection?.client.close().catch(() => {});
  }
  async close(): Promise<void> {
    this.#lifetime.abort();
    this.#token = '';
    await this.#drop();
  }
  invoke(
    tool: string,
    entry: McpToolBinding,
    input: unknown,
    context: CapabilityContext,
  ): Promise<unknown> {
    return this.#serialize(async () => {
      const signal = AbortSignal.any([context.signal, this.#lifetime.signal]);
      try {
        if (signal.aborted) throw failure('cancelled');
        if (input === null || typeof input !== 'object' || Array.isArray(input))
          throw failure('invalid');
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const connection = this.#connection ?? (await this.#connect(signal, entry.timeoutMs));
            if (connection.expired) throw new StreamableHTTPError(404, 'Session reset');
            await this.#credential(signal);
            const tools = await this.#list(connection, signal, entry.timeoutMs);
            if (!this.#pin(tool, entry, tools)) throw failure();
            if (signal.aborted) throw failure('cancelled');
            const result = await connection.limits.request(signal, (requestSignal) =>
              connection.client.request(
                {
                  method: 'tools/call',
                  params: {
                    name: tool,
                    arguments: input as Record<string, unknown>,
                    _meta: {
                      'galaxie.dev/agent': `${context.agent.id}@${context.agent.version}`,
                      'galaxie.dev/run': context.runId,
                      'galaxie.dev/effect': context.effectId,
                    },
                  },
                },
                CallToolResultSchema,
                { signal: requestSignal, timeout: entry.timeoutMs },
              ),
            );
            if (result.isError) {
              this.#options.emit({ code: 'mcp_tool_error', tool });
              throw failure();
            }
            if (entry.result === 'text') {
              if (result.content.some((block) => block.type !== 'text')) throw failure('invalid');
              return this.#result({
                text: result.content
                  .map((block) => (block.type === 'text' ? block.text : ''))
                  .join(''),
              });
            }
            if (result.structuredContent === undefined) throw failure('invalid');
            return this.#result(result.structuredContent);
          } catch (error) {
            if (!(error instanceof StreamableHTTPError && error.code === 404)) throw error;
            this.#options.emit({ code: 'mcp_session_reset', tool });
            await this.#drop();
            if (attempt > 0 || entry.retry === 'none') throw failure();
          }
        }
        throw failure();
      } catch (error) {
        if (signal.aborted || this.#connection?.limits.signal.aborted) await this.#drop();
        if (signal.aborted) throw failure('cancelled');
        throw failure(
          error instanceof GalaxieError
            ? error.code
            : error instanceof McpError && error.code === -32001
              ? 'timeout'
              : 'unavailable',
        );
      }
    });
  }
  #result(value: unknown): unknown {
    if (new TextEncoder().encode(canonical(value)).byteLength > this.#options.limits.resultBytes) {
      this.#options.emit({ code: 'mcp_limit_exceeded' });
      throw failure();
    }
    return value;
  }
}
