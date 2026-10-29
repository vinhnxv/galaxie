// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createServer, type IncomingHttpHeaders } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface McpServerOptions {
  readonly port?: number;
  readonly allowedOrigins: readonly string[];
  readonly verifyToken: (token: string) => string | undefined;
}

export interface ReferenceServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
  readonly admin: {
    tools(): Tool[];
    changeDescription(name: string, description: string): Promise<void>;
    forgetSessions(): Promise<void>;
    requestSampling(): void;
    lastHeaders(): IncomingHttpHeaders;
    counters(): Record<string, number>;
    lastMeta(): Record<string, unknown>;
    callCount(): number;
    samplingCode(): number | undefined;
    cancellations(): number;
    sessionCount(): number;
  };
}

const lesson = z.object({ lessonId: z.string().min(1).max(100) });
const echo = z.object({
  text: z.string().max(100000).optional(),
  size: z.number().int().min(0).max(1000000).optional(),
});

/** Development reference only. Authorization derives from the verified principal, never _meta. */
export async function startMcpServer(options: McpServerOptions): Promise<ReferenceServer> {
  const tools: Tool[] = [
    {
      name: 'lesson.lookup',
      title: 'Lesson lookup',
      description: 'Look up a lesson.',
      inputSchema: {
        type: 'object',
        properties: { lessonId: { type: 'string' } },
        required: ['lessonId'],
      },
      outputSchema: {
        type: 'object',
        properties: { lessonId: { type: 'string' }, title: { type: 'string' } },
        required: ['lessonId', 'title'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'progress.record',
      description: 'Record practice progress.',
      inputSchema: {
        type: 'object',
        properties: { lessonId: { type: 'string' } },
        required: ['lessonId'],
      },
      annotations: { readOnlyHint: false },
    },
    {
      name: 'text.echo',
      description: 'Return text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, size: { type: 'integer' } },
      },
      annotations: { readOnlyHint: true },
    },
  ];
  const sessions = new Map<
    string,
    { principal: string; server: Server; transport: StreamableHTTPServerTransport }
  >();
  const effects = new Map<string, Map<string, number>>();
  let headers: IncomingHttpHeaders = {};
  let meta: Record<string, unknown> = {};
  let calls = 0;
  let sampling = false;
  let samplingCode: number | undefined;
  let cancellations = 0;
  const forgetSessions = async (): Promise<void> => {
    const active = [...sessions.values()];
    sessions.clear();
    await Promise.all(active.map(({ server }) => server.close()));
  };
  const http = createServer(async (request, response) => {
    try {
      const origin = request.headers.origin;
      if (origin === undefined || !options.allowedOrigins.includes(origin)) {
        response.writeHead(403).end();
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      response.setHeader(
        'Access-Control-Allow-Headers',
        'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
      );
      response.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
      if (request.method === 'OPTIONS') {
        response.writeHead(204).end();
        return;
      }
      const bearer = request.headers.authorization;
      const principal = bearer?.startsWith('Bearer ')
        ? options.verifyToken(bearer.slice(7))
        : undefined;
      if (principal === undefined || principal.length === 0) {
        response.writeHead(401).end();
        return;
      }
      headers = Object.fromEntries(
        Object.entries(request.headers).filter(([key]) =>
          ['origin', 'mcp-session-id', 'mcp-protocol-version'].includes(key),
        ),
      );
      const id = request.headers['mcp-session-id'];
      if (id !== undefined) {
        const session = typeof id === 'string' ? sessions.get(id) : undefined;
        if (session === undefined) {
          response.writeHead(404).end();
          return;
        }
        if (session.principal !== principal) {
          response.writeHead(403).end();
          return;
        }
        await session.transport.handleRequest(request, response);
        return;
      }
      if (request.method !== 'POST') {
        response.writeHead(400).end();
        return;
      }
      const server = new Server(
        { name: 'galaxie-reference', version: '1' },
        { capabilities: { tools: { listChanged: true } } },
      );
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, { principal, server, transport });
        },
        onsessionclosed: (sessionId) => {
          sessions.delete(sessionId);
        },
      });
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: structuredClone(tools) }));
      server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
        calls++;
        meta = structuredClone(call.params._meta ?? {});
        extra.signal.addEventListener(
          'abort',
          () => {
            cancellations++;
          },
          { once: true },
        );
        if (sampling) {
          sampling = false;
          // Send directly so the test exercises rejection even without advertised sampling.
          await transport.send(
            {
              jsonrpc: '2.0',
              id: 'sampling-probe',
              method: 'sampling/createMessage',
              params: { messages: [], maxTokens: 1 },
            },
            { relatedRequestId: extra.requestId },
          );
        }
        if (call.params.name === 'lesson.lookup') {
          const parsed = lesson.safeParse(call.params.arguments);
          if (parsed.success)
            return {
              content: [],
              structuredContent: { lessonId: parsed.data.lessonId, title: 'Practice lesson' },
            };
        } else if (call.params.name === 'progress.record') {
          const parsed = lesson.safeParse(call.params.arguments);
          const effect = call.params._meta?.['galaxie.dev/effect'];
          if (parsed.success && typeof effect === 'string' && effect.length > 0) {
            let journal = effects.get(principal);
            if (journal === undefined) {
              journal = new Map();
              effects.set(principal, journal);
            }
            let count = journal.get(effect);
            if (count === undefined) {
              count = journal.size + 1;
              journal.set(effect, count);
            }
            return { content: [], structuredContent: { count } };
          }
        } else if (call.params.name === 'text.echo') {
          const parsed = echo.safeParse(call.params.arguments);
          if (parsed.success)
            return {
              content: [
                {
                  type: 'text',
                  text:
                    parsed.data.size === undefined
                      ? (parsed.data.text ?? '')
                      : 'x'.repeat(parsed.data.size),
                },
              ],
            };
        }
        return { isError: true, content: [{ type: 'text', text: 'Invalid tool request.' }] };
      });
      // SDK accessor declarations include undefined; its Transport optional properties do not.
      await server.connect(transport as Parameters<Server['connect']>[0]);
      const receive = transport.onmessage;
      transport.onmessage = (message, extra) => {
        if ('id' in message && message.id === 'sampling-probe' && 'error' in message)
          samplingCode = message.error.code;
        else receive?.(message, extra);
      };
      await transport.handleRequest(request, response);
      if (transport.sessionId === undefined) await server.close();
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port ?? 0, '127.0.0.1', () => {
      http.removeListener('error', reject);
      resolve();
    });
  });
  const address = http.address();
  if (address === null || typeof address === 'string')
    throw new Error('Reference server did not start.');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    port: address.port,
    async close(): Promise<void> {
      await forgetSessions();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        http.close((error) =>
          error === undefined ? resolve() : reject(new Error('Reference server did not close.')),
        ),
      );
    },
    admin: {
      tools: () => structuredClone(tools),
      async changeDescription(name, description): Promise<void> {
        const tool = tools.find((entry) => entry.name === name);
        if (tool !== undefined) tool.description = description;
        await Promise.all([...sessions.values()].map(({ server }) => server.sendToolListChanged()));
      },
      forgetSessions,
      requestSampling: () => {
        sampling = true;
        samplingCode = undefined;
      },
      lastHeaders: () => ({ ...headers }),
      counters: () =>
        Object.fromEntries([...effects].map(([principal, journal]) => [principal, journal.size])),
      lastMeta: () => structuredClone(meta),
      callCount: () => calls,
      samplingCode: () => samplingCode,
      cancellations: () => cancellations,
      sessionCount: () => sessions.size,
    },
  };
}
