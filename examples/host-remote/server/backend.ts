// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Demonstration stub only: no real accounts, upstream provider or durable storage.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server } from 'node:net';
import type { Plugin } from 'vite';
import { lesson, quiz } from './fixtures.js';

const processUpstreamKey = randomUUID();
const cookieName = 'galaxie-agent-session';

interface Session {
  token: string;
  cookie: string;
  learnerId: string;
  expiresAt: number;
}

function agentCookie(header: string | undefined): string | undefined {
  const matches = (header ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.slice(0, part.indexOf('=')) === cookieName);
  return matches.length === 1 ? matches[0]?.slice(cookieName.length + 1) : undefined;
}

function sessionCookie(value: string, maxAge: number): string {
  return `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=${maxAge}`;
}

interface ProgressInput {
  lessonId: string;
  score: number;
  total: number;
}

function validProgress(value: unknown): value is ProgressInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === 3 &&
    typeof row['lessonId'] === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(row['lessonId']) &&
    typeof row['score'] === 'number' &&
    Number.isInteger(row['score']) &&
    row['score'] >= 0 &&
    typeof row['total'] === 'number' &&
    Number.isInteger(row['total']) &&
    row['total'] <= 20 &&
    row['score'] <= row['total']
  );
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 262_144) throw new Error('Request too large.');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function backend(options: { now?: () => number; upstreamKey?: string } = {}): Plugin {
  const now = options.now ?? Date.now;
  const upstreamKey =
    options.upstreamKey ?? process.env['HOST_REMOTE_UPSTREAM_KEY'] ?? processUpstreamKey;
  let testMode = false;
  function middleware(
    server: Server,
  ): (req: IncomingMessage, res: ServerResponse, next: () => void) => void {
    let authority: string | undefined;
    const listening = (): void => {
      const address = server.address();
      if (address && typeof address !== 'string' && address.address === '127.0.0.1')
        authority = `127.0.0.1:${address.port}`;
    };
    if (server.listening) listening();
    else server.once('listening', listening);
    const sessions = new Map<string, Session>();
    const cookieSessions = new Map<string, Session>();
    const proxyBodies: unknown[] = [];
    const proxyHeaderNames: string[][] = [];
    const progress: (ProgressInput & { learnerId: string })[] = [];
    const requests: Record<string, number> = {};
    const count = (route: string): void => {
      requests[route] = (requests[route] ?? 0) + 1;
    };
    async function handle(
      request: IncomingMessage,
      response: ServerResponse,
      path: string,
    ): Promise<void> {
      const route = `${request.method} ${path}`;
      const modelRoute = route === 'POST /api/v1/chat/completions';
      const endRoute = route === 'POST /api/v1/session/end';
      const issueRoute = route === 'POST /api/session';
      if (
        !authority ||
        request.headers.host !== authority ||
        (request.headers.origin !== undefined &&
          request.headers.origin !== `http://${authority}`) ||
        ((issueRoute || modelRoute || endRoute) && request.headers.origin === undefined)
      ) {
        json(response, 403, { error: 'forbidden' });
        return;
      }
      if (issueRoute) {
        // Demo-only open issuance: a real host must require its own signed-in user here.
        count(route);
        const token = randomUUID();
        const cookie = randomUUID();
        const expiresAt = now() + 300_000;
        const session = { token, cookie, learnerId: 'demo-learner', expiresAt };
        sessions.set(token, session);
        cookieSessions.set(cookie, session);
        response.setHeader('set-cookie', sessionCookie(cookie, 300));
        json(response, 200, { token, expiresAt });
        return;
      }
      const cookie = agentCookie(request.headers.cookie);
      const cookieSession = cookie === undefined ? undefined : cookieSessions.get(cookie);
      if (endRoute) {
        count(route);
        if (cookieSession) {
          sessions.delete(cookieSession.token);
          cookieSessions.delete(cookieSession.cookie);
        }
        response.setHeader('set-cookie', sessionCookie('', 0));
        json(response, 200, { ended: true });
        return;
      }
      const authorization = request.headers.authorization;
      const session = modelRoute
        ? cookieSession
        : authorization?.startsWith('Bearer ')
          ? sessions.get(authorization.slice(7))
          : undefined;
      if (!session || session.expiresAt <= now()) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      if (route === 'GET /api/__test/state' && testMode) {
        count(route);
        json(response, 200, { proxyBodies, proxyHeaderNames, progress, requests });
      } else if (request.method === 'GET' && path.startsWith('/api/lessons/')) {
        count('GET /api/lessons/:lessonId');
        json(
          response,
          path === `/api/lessons/${lesson.id}` ? 200 : 404,
          path === `/api/lessons/${lesson.id}` ? lesson : { error: 'not_found' },
        );
      } else if (route === 'POST /api/progress') {
        count(route);
        const input = await body(request);
        if (!validProgress(input)) {
          json(response, 400, { error: 'invalid' });
          return;
        }
        if (input.lessonId !== lesson.id) {
          json(response, 403, { error: 'forbidden' });
          return;
        }
        progress.push({ ...input, learnerId: session.learnerId });
        json(response, 200, { saved: true });
      } else if (modelRoute) {
        count(route);
        const input = await body(request);
        if (typeof input !== 'object' || input === null || Array.isArray(input)) {
          json(response, 400, { error: 'invalid' });
          return;
        }
        proxyBodies.push(input);
        const headers = new Headers({
          'content-type': request.headers['content-type'] ?? 'application/json',
          accept: request.headers.accept ?? 'application/json',
          authorization: `Bearer ${upstreamKey}`,
        });
        if (testMode) proxyHeaderNames.push([...headers.keys()]);
        stubUpstream(headers, input, response);
      } else json(response, 404, { error: 'not_found' });
    }
    function stubUpstream(headers: Headers, input: object, response: ServerResponse): void {
      if (headers.get('authorization') !== `Bearer ${upstreamKey}`) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      const streaming = 'stream' in input && input.stream === true;
      const content = JSON.stringify(quiz);
      const usage = { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 };
      const envelope = { id: 'demo-quiz', created: 0, model: 'host-quiz' };
      if (!streaming) {
        json(response, 200, {
          ...envelope,
          object: 'chat.completion',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
          usage,
        });
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
      });
      const frame = (value: unknown): void => {
        response.write(`data: ${JSON.stringify(value)}\n\n`);
      };
      for (let offset = 0; offset < content.length; offset += 80) {
        frame({
          ...envelope,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                ...(offset === 0 ? { role: 'assistant' } : {}),
                content: content.slice(offset, offset + 80),
              },
              finish_reason: null,
            },
          ],
        });
      }
      frame({
        ...envelope,
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
      frame({ ...envelope, object: 'chat.completion.chunk', choices: [], usage });
      response.end('data: [DONE]\n\n');
    }
    return (request, response, next): void => {
      const path = request.url?.split('?')[0] ?? '';
      if (path !== '/api' && !path.startsWith('/api/')) {
        next();
        return;
      }
      void handle(request, response, path).catch(() => {
        if (!response.headersSent) json(response, 400, { error: 'invalid' });
        else response.end();
      });
    };
  }
  return {
    name: 'host-remote-backend',
    configResolved(config) {
      testMode = config.mode === 'test';
    },
    configureServer(server) {
      if (server.httpServer) server.middlewares.use(middleware(server.httpServer));
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware(server.httpServer));
    },
  };
}
