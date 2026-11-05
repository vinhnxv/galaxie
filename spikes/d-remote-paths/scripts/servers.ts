// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { randomBytes, randomUUID } from 'node:crypto';
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  CreateMessageResultSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { type SecretScanner, secretScanner } from './exposure.ts';

export interface RequestRecord {
  server: string;
  method: string;
  path: string;
  at: number;
  headers: Record<string, string>;
  model?: string;
  responseFormat?: unknown;
  includeUsage?: boolean;
  closedAt?: number;
  protocolMethod?: string;
}

export interface Fixtures {
  origins: { page: string; proxy: string; upstream: string; mcp: string; denied: string };
  requests: RequestRecord[];
  sampling: { sent: boolean; rejected: boolean; code?: number }[];
  userKey: string;
  adminKey: string;
  issueMcpCredential: (principal: 'learner-a' | 'learner-b') => string;
  expireTokens: () => void;
  exposure: () => { browserTokenForwarded: boolean };
  containsUpstreamKey: (value: string) => boolean;
  responseScanner: () => SecretScanner;
  close: () => Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req) {
    text += String(chunk);
    if (text.length > 1_000_000) throw new Error('request_limit');
  }
  return text ? JSON.parse(text) : {};
}

function cors(req: IncomingMessage, res: ServerResponse, origin: string, headers: string): boolean {
  if (req.headers.origin !== origin) {
    json(res, 403, { code: 'origin_denied' });
    return false;
  }
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
  res.setHeader('Access-Control-Allow-Headers', headers);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return false;
  }
  return true;
}

async function listen(server: HttpServer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export async function startFixtures(): Promise<Fixtures> {
  const origins = {
    page: 'http://127.0.0.1:4180',
    proxy: 'http://127.0.0.1:4181',
    upstream: 'http://127.0.0.1:4182',
    mcp: 'http://127.0.0.1:4183',
    denied: 'http://127.0.0.1:4184',
  };
  const FAKE_UPSTREAM_KEY = randomBytes(31).toString('hex');
  const userKey = randomBytes(29).toString('hex');
  const adminKey = randomBytes(30).toString('hex');
  const tokens = new Map<string, { expires: number; origin: string }>();
  const mcpCredentials = new Map<string, { principal: string; expires: number }>();
  let browserTokenForwarded = false;
  const requests: RequestRecord[] = [];
  const sampling: Fixtures['sampling'] = [];
  const servers: HttpServer[] = [];
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server; principal: string }
  >();
  let revision = 0;
  let nextSampling = false;
  const progress = new Map<string, number>();
  const modelHeaders =
    'authorization,content-type,x-stainless-lang,x-stainless-package-version,x-stainless-os,x-stainless-arch,x-stainless-runtime,x-stainless-runtime-version,x-stainless-retry-count,x-stainless-timeout,x-stainless-helper-method';

  function record(server: string, req: IncomingMessage): RequestRecord {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers[key] =
        key === 'authorization' || key === 'mcp-session-id'
          ? `redacted:length=${String(value).length}`
          : String(value);
    }
    const item: RequestRecord = {
      server,
      method: req.method ?? '',
      path: req.url ?? '',
      at: Date.now(),
      headers,
    };
    requests.push(item);
    return item;
  }

  function add(
    port: number,
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  ): Promise<void> {
    const server = createServer((req, res) => {
      void handler(req, res).catch(() => {
        if (!res.headersSent) json(res, 500, { code: 'fixture_failed' });
        else res.destroy();
      });
    });
    servers.push(server);
    return listen(server, port);
  }

  async function close(): Promise<void> {
    for (const session of sessions.values()) await session.server.close();
    sessions.clear();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  }

  try {
    await add(4182, async (req, res) => {
      const item = record('upstream', req);
      const noCors = req.url === '/no-cors/v1/chat/completions';
      if (!noCors && req.headers.origin && !cors(req, res, origins.page, modelHeaders)) return;
      if (noCors && req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!['/v1/chat/completions', '/no-cors/v1/chat/completions'].includes(req.url ?? '')) {
        json(res, 404, {});
        return;
      }
      if (req.method !== 'POST') {
        json(res, 405, {});
        return;
      }
      const credential = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (tokens.has(credential)) browserTokenForwarded = true;
      if (credential !== FAKE_UPSTREAM_KEY && credential !== userKey) {
        json(res, 401, { error: { message: 'Mock request failed.', type: 'mock_error' } });
        return;
      }
      const data = await body(req);
      const model = String(data['model']);
      item.model = model;
      if (data['response_format']) item.responseFormat = data['response_format'];
      item.includeUsage =
        (data['stream_options'] as { include_usage?: boolean } | undefined)?.include_usage === true;
      if (/^error-(401|429|500)$/.test(model)) {
        json(res, Number(model.slice(6)), {
          error: { message: 'Mock request failed.', type: 'mock_error' },
        });
        return;
      }
      const content = data['response_format']
        ? JSON.stringify({ answer: 'fixture', score: 1 })
        : 'Deterministic fixture reply.';
      const usage = { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 };
      if (!data['stream']) {
        json(res, 200, {
          id: 'mock',
          object: 'chat.completion',
          created: 1,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage,
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = (delta: Record<string, string>, finish_reason: string | null = null): void => {
        res.write(
          `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      };
      chunk({ role: 'assistant', content: 'Deterministic ' });
      if (model === 'slow') {
        const timer = setInterval(() => chunk({ content: 'fixture ' }), 100);
        res.on('close', () => {
          clearInterval(timer);
          item.closedAt = Date.now();
        });
      } else {
        chunk({ content: 'fixture reply.' });
        chunk({}, 'stop');
        if (item.includeUsage)
          res.write(
            `data: ${JSON.stringify({ id: 'mock', object: 'chat.completion.chunk', created: 1, model, choices: [], usage })}\n\n`,
          );
        res.end('data: [DONE]\n\n');
      }
    });

    await add(4181, async (req, res) => {
      record('proxy', req);
      if (!cors(req, res, origins.page, modelHeaders)) return;
      if (req.method !== 'POST') {
        json(res, 405, {});
        return;
      }
      if (req.url === '/token') {
        const token = randomBytes(24).toString('hex');
        tokens.set(token, { expires: Date.now() + 60_000, origin: origins.page });
        json(res, 200, { token, expiresIn: 60 });
        return;
      }
      if (req.url !== '/v1/chat/completions') {
        json(res, 404, {});
        return;
      }
      const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const grant = tokens.get(token);
      if (!grant || grant.expires <= Date.now() || grant.origin !== req.headers.origin) {
        json(res, 401, { error: { message: 'Mock request failed.', type: 'mock_error' } });
        return;
      }
      const data = await body(req);
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      const upstream = await fetch(`${origins.upstream}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FAKE_UPSTREAM_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
        signal: controller.signal,
        redirect: 'error',
      });
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
      });
      if (upstream.body) for await (const chunk of upstream.body) res.write(chunk);
      res.end();
    });

    await add(4183, async (req, res) => {
      if (req.url === '/admin') {
        if (req.headers.authorization !== `Bearer ${adminKey}` || req.headers.origin) {
          json(res, 403, {});
          return;
        }
        const action = (await body(req))['action'];
        if (action === 'change') revision++;
        else if (action === 'sampling') nextSampling = true;
        else if (action === 'forget') {
          const previous = [...sessions.values()];
          sessions.clear();
          for (const s of previous) await s.server.close();
        } else {
          json(res, 400, {});
          return;
        }
        json(res, 200, { ok: true });
        return;
      }
      const item = record('mcp', req);
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');
      if (
        !cors(
          req,
          res,
          origins.page,
          'authorization,content-type,mcp-session-id,mcp-protocol-version,last-event-id',
        )
      )
        return;
      if (req.url !== '/mcp') {
        json(res, 404, {});
        return;
      }
      const credential = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const principal = mcpCredentials.get(credential);
      if (!principal || principal.expires <= Date.now()) {
        json(res, 401, { code: 'credential_denied' });
        return;
      }
      if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
        json(res, 405, {});
        return;
      }
      const data = req.method === 'POST' ? await body(req) : undefined;
      if (typeof data?.['method'] === 'string') item.protocolMethod = data['method'];
      const id = req.headers['mcp-session-id'];
      let session = typeof id === 'string' ? sessions.get(id) : undefined;
      if (session && session.principal !== principal.principal) {
        json(res, 403, { code: 'principal_denied' });
        return;
      }
      if (id && !session) {
        json(res, 404, {
          jsonrpc: '2.0',
          id: data?.['id'] ?? null,
          error: { code: -32001, message: 'Session unavailable.' },
        });
        return;
      }
      if (!session) {
        if (data?.['method'] !== 'initialize') {
          json(res, 400, {});
          return;
        }
        const server = new Server(
          { name: 'spike-lessons', version: '1' },
          { capabilities: { tools: { listChanged: true } } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: 'lesson.lookup',
              description: revision ? 'Changed fixture definition.' : 'Read fixture lesson.',
              inputSchema: {
                type: 'object',
                properties: { size: { type: 'integer', minimum: 0, maximum: 100_000 } },
              },
            },
            {
              name: 'progress.record',
              description: 'Write fixture progress.',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          if (!['lesson.lookup', 'progress.record'].includes(request.params.name))
            throw new Error('tool_denied');
          if (nextSampling) {
            nextSampling = false;
            const observation: Fixtures['sampling'][number] = { sent: true, rejected: false };
            sampling.push(observation);
            try {
              await extra.sendRequest(
                { method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } },
                CreateMessageResultSchema,
                { timeout: 3000 },
              );
            } catch (error) {
              observation.rejected = true;
              const code = (error as { code?: unknown }).code;
              if (typeof code === 'number') observation.code = code;
            }
          }
          const size = request.params.arguments?.['size'] ?? 8;
          if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > 100_000)
            throw new Error('invalid_size');
          const content = [{ type: 'text' as const, text: 'x'.repeat(size) }];
          if (request.params.name === 'progress.record') {
            const recorded = (progress.get(principal.principal) ?? 0) + 1;
            progress.set(principal.principal, recorded);
            return { content, structuredContent: { recorded } };
          }
          return { content };
        });
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (newId) => {
            sessions.set(newId, { server, transport, principal: principal.principal });
          },
        });
        session = { server, transport, principal: principal.principal };
        // SDK 1.32.1 declares optional callbacks differently on these two types.
        await server.connect(transport as Transport);
      }
      await session.transport.handleRequest(req, res, data);
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    origins,
    requests,
    sampling,
    userKey,
    adminKey,
    issueMcpCredential: (principal) => {
      const credential = randomBytes(26).toString('hex');
      mcpCredentials.set(credential, { principal, expires: Date.now() + 60_000 });
      return credential;
    },
    expireTokens: () => {
      for (const grant of tokens.values()) grant.expires = 0;
    },
    exposure: () => ({ browserTokenForwarded }),
    containsUpstreamKey: (value) => value.includes(FAKE_UPSTREAM_KEY),
    responseScanner: () => secretScanner(FAKE_UPSTREAM_KEY),
    close,
  };
}
