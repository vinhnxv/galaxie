// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export type GatewayScope = 'model' | 'note.save@1' | 'docs.search@1';

export interface GatewayUser {
  readonly documentIds: readonly string[];
  readonly scopes?: readonly GatewayScope[];
}

export interface GatewayDocument {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

export interface GatewayPrompt {
  /** Each variable is a non-empty string with this maximum length; extra keys are refused. */
  readonly variables: Readonly<Record<string, number>>;
  readonly template: string;
}

export interface GatewayOptions {
  readonly upstream?: { readonly baseURL: string; readonly apiKey: string };
  readonly users?: Readonly<Record<string, GatewayUser>>;
  readonly quota?: { readonly calls: number; readonly windowMs: number };
  readonly models?: readonly string[];
  readonly prompts?: Readonly<Record<string, GatewayPrompt>>;
  readonly documents?: readonly GatewayDocument[];
  readonly now?: () => number;
  readonly idempotency?: { readonly maxRecords: number; readonly ttlMs: number };
}

export interface GatewayNote {
  readonly id: string;
  readonly principal: string;
  readonly text: string;
}

export interface Gateway {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  /** Server-only inspection, never exposed by an HTTP route. */
  readonly notes: readonly GatewayNote[];
}

const scopes: readonly GatewayScope[] = ['model', 'note.save@1', 'docs.search@1'];
const demoUsers: Readonly<Record<string, GatewayUser>> = {
  'demo-ada': { documentIds: ['ada-guide'] },
  'demo-lin': { documentIds: ['lin-guide'] },
};
const demoDocuments: readonly GatewayDocument[] = [
  { id: 'ada-guide', title: 'Ada practice guide', text: 'Practice addition in small steps.' },
  { id: 'lin-guide', title: 'Lin practice guide', text: 'Practice multiplication with examples.' },
];
const demoPrompts: Readonly<Record<string, GatewayPrompt>> = {
  'practice-comment': {
    variables: { tone: 32 },
    template: 'You are a practice coach. Give one short {{tone}} sentence. Keep it under 20 words.',
  },
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) {
      request.resume();
      throw new Error('invalid');
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function render(prompt: GatewayPrompt, value: unknown): string | undefined {
  if (!record(value) || Object.keys(value).length !== Object.keys(prompt.variables).length) {
    return undefined;
  }
  for (const [name, max] of Object.entries(prompt.variables)) {
    const variable = value[name];
    if (typeof variable !== 'string' || variable.trim().length === 0 || variable.length > max) {
      return undefined;
    }
  }
  return prompt.template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_match, name: string) =>
    String(value[name]),
  );
}

/** In-memory demonstration gateway. Only the token selects the principal and route scopes. */
export function createGateway(options: GatewayOptions = {}): Gateway {
  const now = options.now ?? Date.now;
  const users = options.users ?? demoUsers;
  const documents = options.documents ?? demoDocuments;
  const prompts = options.prompts ?? demoPrompts;
  const models = options.models ?? ['gateway-comment'];
  const quota = options.quota ?? { calls: 10, windowMs: 60_000 };
  const retention = options.idempotency ?? { maxRecords: 1000, ttlMs: 300_000 };
  const sessions = new Map<
    string,
    { principal: string; expiresAt: number; scopes: readonly GatewayScope[] }
  >();
  const calls = new Map<string, { count: number; expiresAt: number }>();
  const receipts = new Map<
    string,
    { digest: string; expiresAt: number; response: { id: string; saved: true } }
  >();
  const notes: GatewayNote[] = [];

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const authority = `127.0.0.1:${request.socket.localPort}`;
    if (
      request.headers.host !== authority ||
      (request.headers.origin !== undefined && request.headers.origin !== `http://${authority}`)
    ) {
      json(response, 403, { error: 'forbidden' });
      return;
    }
    const url = new URL(request.url ?? '/', `http://${authority}`);
    const route = `${request.method} ${url.pathname}`;
    const time = now();
    for (const [key, value] of sessions) if (value.expiresAt <= time) sessions.delete(key);
    for (const [key, value] of receipts) if (value.expiresAt <= time) receipts.delete(key);
    for (const [key, value] of calls) if (value.expiresAt <= time) calls.delete(key);
    if (route === 'POST /api/session') {
      const input = await body(request);
      if (
        !record(input) ||
        typeof input['userId'] !== 'string' ||
        !Object.hasOwn(users, input['userId'])
      ) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      if (sessions.size >= 1000) {
        json(response, 503, { error: 'unavailable' });
        return;
      }
      const principal = input['userId'];
      const user = users[principal];
      if (user === undefined) throw new Error('invalid');
      const token = randomBytes(32).toString('hex');
      const expiresAt = time + 300_000;
      sessions.set(token, { principal, expiresAt, scopes: user.scopes ?? scopes });
      json(response, 200, { token, expiresAt });
      return;
    }
    const authorization = request.headers.authorization;
    const session = authorization?.startsWith('Bearer ')
      ? sessions.get(authorization.slice(7))
      : undefined;
    const scope =
      route === 'POST /api/v1/chat/completions'
        ? 'model'
        : route === 'POST /api/notes'
          ? 'note.save@1'
          : route === 'GET /api/docs/search'
            ? 'docs.search@1'
            : undefined;
    if (!session || (scope !== undefined && !session.scopes.includes(scope))) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }
    const principal = session.principal;
    if (scope === 'model') {
      const input = await body(request);
      if (!record(input)) {
        json(response, 400, { error: 'invalid' });
        return;
      }
      if (typeof input['model'] !== 'string' || !models.includes(input['model'])) {
        json(response, 403, { error: 'model_not_allowed' });
        return;
      }
      const messages = input['messages'];
      if (
        !Array.isArray(messages) ||
        messages.length > 32 ||
        messages.some(
          (message: unknown) =>
            !record(message) ||
            !['user', 'assistant'].includes(String(message['role'])) ||
            typeof message['content'] !== 'string',
        )
      ) {
        json(response, 400, { error: 'invalid_messages' });
        return;
      }
      const metadata = input['metadata'];
      const promptId = record(metadata) ? metadata['promptId'] : undefined;
      if (typeof promptId !== 'string' || !Object.hasOwn(prompts, promptId)) {
        json(response, 400, { error: 'invalid_prompt' });
        return;
      }
      const prompt = prompts[promptId];
      const system =
        prompt === undefined || !record(metadata)
          ? undefined
          : render(prompt, metadata['variables']);
      if (system === undefined) {
        json(response, 400, { error: 'invalid_variables' });
        return;
      }
      const usage = calls.get(principal) ?? { count: 0, expiresAt: time + quota.windowMs };
      if (usage.count >= quota.calls) {
        json(response, 429, { error: 'quota_exceeded' });
        return;
      }
      // Reserve before awaiting the upstream, so concurrent requests cannot bypass the quota.
      usage.count++;
      calls.set(principal, usage);
      if (!options.upstream) {
        json(response, 503, { error: 'unavailable' });
        return;
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      response.once('close', abort);
      const timeout = setTimeout(abort, 30_000);
      try {
        const upstream = await fetch(
          `${options.upstream.baseURL.replace(/\/$/, '')}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${options.upstream.apiKey}`,
            },
            redirect: 'error',
            signal: controller.signal,
            // Project known fields only: identity, metadata, raw prompts and arbitrary SDK options never forward.
            body: JSON.stringify({
              model: input['model'],
              messages: [
                { role: 'system', content: system },
                ...messages.map((message: Record<string, unknown>) => ({
                  role: message['role'],
                  content: message['content'],
                })),
              ],
              stream: input['stream'] === true,
              ...(input['stream'] === true ? { stream_options: { include_usage: true } } : {}),
              max_tokens: 48,
            }),
          },
        );
        if (!upstream.ok) {
          await upstream.body?.cancel();
          const status =
            upstream.status === 401 || upstream.status === 403
              ? 403
              : upstream.status === 429
                ? 429
                : 502;
          json(response, status, {
            error: status === 403 ? 'denied' : status === 429 ? 'quota_exceeded' : 'unavailable',
          });
          return;
        }
        response.writeHead(upstream.status, {
          'content-type': input['stream'] === true ? 'text/event-stream' : 'application/json',
          'cache-control': 'no-store',
        });
        if (upstream.body) {
          const reader = upstream.body.getReader();
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (!response.write(chunk.value)) {
                await new Promise<void>((resolve) => {
                  const finish = (): void => {
                    response.off('drain', finish);
                    response.off('close', finish);
                    resolve();
                  };
                  response.once('drain', finish);
                  response.once('close', finish);
                });
              }
              if (controller.signal.aborted) break;
            }
          } finally {
            reader.releaseLock();
          }
        }
        response.end();
      } catch {
        if (!response.headersSent) json(response, 502, { error: 'unavailable' });
        else response.end();
      } finally {
        clearTimeout(timeout);
        response.off('close', abort);
      }
    } else if (scope === 'note.save@1') {
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(key)) {
        json(response, 400, { error: 'idempotency_key_required' });
        return;
      }
      const input = await body(request);
      if (
        !record(input) ||
        typeof input['text'] !== 'string' ||
        input['text'].trim().length === 0 ||
        input['text'].length > 2000
      ) {
        json(response, 400, { error: 'invalid' });
        return;
      }
      const digest = createHash('sha256')
        .update(JSON.stringify({ text: input['text'] }))
        .digest('hex');
      const receiptKey = JSON.stringify([principal, key, 'note.save@1']);
      const previous = receipts.get(receiptKey);
      if (previous) {
        json(
          response,
          previous.digest === digest ? 200 : 409,
          previous.digest === digest ? previous.response : { error: 'idempotency_conflict' },
        );
        return;
      }
      // Refuse new writes at capacity; evicting a live receipt could repeat a write.
      if (receipts.size >= retention.maxRecords || notes.length >= 1000) {
        json(response, 503, { error: 'unavailable' });
        return;
      }
      const result = { id: randomUUID(), saved: true as const };
      notes.push({ id: result.id, principal, text: input['text'] });
      receipts.set(receiptKey, { digest, expiresAt: time + retention.ttlMs, response: result });
      json(response, 200, result);
    } else if (scope === 'docs.search@1') {
      const query = url.searchParams.get('q') ?? '';
      if (query.length === 0 || query.length > 200) {
        json(response, 400, { error: 'invalid' });
        return;
      }
      const allowed = users[principal]?.documentIds ?? [];
      const results = documents
        .filter(
          (document) =>
            allowed.includes(document.id) &&
            `${document.title} ${document.text}`.toLowerCase().includes(query.toLowerCase()),
        )
        .slice(0, 5)
        .map((document) => ({
          id: document.id,
          title: document.title.slice(0, 120),
          snippet: document.text.slice(0, 160),
        }));
      json(response, 200, { results });
    } else json(response, 404, { error: 'not_found' });
  }
  return {
    notes,
    async handle(request, response) {
      try {
        await route(request, response);
      } catch {
        if (!response.headersSent) json(response, 400, { error: 'invalid' });
        else response.end();
      }
    },
  };
}
