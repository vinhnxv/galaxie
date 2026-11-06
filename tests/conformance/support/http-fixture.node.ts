// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from 'node:http';
import {
  HTTP_ERROR_BODY,
  HTTP_ORIGIN,
  type HttpControl,
  type HttpRequestRecord,
} from './http-context.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('HTTP test fixture address is unavailable.');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
    server.closeAllConnections();
  });
}

export async function createHttpFixture(): Promise<HttpControl> {
  const requests: HttpRequestRecord[] = [];
  const completion = { id: 'loopback-completion', created: 0, model: 'fake' };
  const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
  const servers = (['cors', 'no-cors'] as const).map((name) =>
    createServer(async (request, response) => {
      request.resume();
      const path = request.url ?? '';
      if (name === 'cors') {
        response.setHeader('Access-Control-Allow-Origin', HTTP_ORIGIN);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        // Keep each chat test's preflight visible in its own request log.
        if (path === '/v1/chat/completions') response.setHeader('Access-Control-Max-Age', '0');
        response.setHeader(
          'Access-Control-Allow-Headers',
          path === '/v1/chat/completions'
            ? 'content-type, authorization, x-stainless-lang, x-stainless-package-version, x-stainless-os, x-stainless-arch, x-stainless-runtime, x-stainless-runtime-version, x-stainless-retry-count, x-stainless-timeout, x-stainless-helper-method'
            : 'content-type, authorization, x-galaxie-agent, x-galaxie-run',
        );
      }
      const method = request.method ?? '';
      if (name === 'cors' && path === '/__admin' && method !== 'OPTIONS') {
        if (method === 'POST') requests.length = 0;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ requests }));
        return;
      }
      const agent = request.headers['x-galaxie-agent'];
      let status = 404;
      let rejected = false;
      let body: unknown = { error: 'not_found' };
      let streaming = false;
      let toolCall = false;
      if (method === 'OPTIONS') {
        status = 204;
      } else if (name === 'cors' && method === 'POST' && path === '/v1/chat/completions') {
        try {
          request.setEncoding('utf8');
          let input = '';
          for await (const chunk of request) input += chunk;
          const parsed = JSON.parse(input) as {
            model?: string;
            stream?: boolean;
            tools?: { function?: { name?: string } }[];
            messages?: {
              role?: string;
              content?: string;
              tool_call_id?: string;
              tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
            }[];
          };
          streaming = parsed.stream === true;
          if (parsed.model === 'fake-tools') {
            if (!parsed.tools?.some((tool) => tool.function?.name === 'echo_1'))
              throw new Error('Missing fixture tool declaration.');
            const last = parsed.messages?.at(-1);
            toolCall = last?.role !== 'tool';
            if (!toolCall) {
              const assistant = parsed.messages?.at(-2);
              const call = assistant?.tool_calls?.[0];
              if (
                assistant?.role !== 'assistant' ||
                assistant.tool_calls?.length !== 1 ||
                call?.id !== 'loopback-tool-id' ||
                call.function?.name !== 'echo_1' ||
                call.function.arguments !== '{"q":"query"}' ||
                last?.tool_call_id !== 'loopback-tool-id' ||
                last.content !== '{"found":"query"}'
              )
                throw new Error('Invalid fixture tool history.');
            }
          }
          status = 200;
          body = {
            ...completion,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                finish_reason: toolCall ? 'tool_calls' : 'stop',
                message: toolCall
                  ? {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'loopback-tool-id',
                          type: 'function',
                          function: { name: 'echo_1', arguments: '{"q":"query"}' },
                        },
                      ],
                    }
                  : { role: 'assistant', content: 'loopback reply' },
              },
            ],
            usage,
          };
        } catch {
          status = 400;
          streaming = false;
          body = { error: 'invalid_request' };
        }
      } else if (method === 'GET' && /^\/public\/items\/[^/]+$/.test(path)) {
        status = 200;
        body = { id: path.slice('/public/items/'.length), title: 'Fixture item' };
      } else if (method === 'POST' && path === '/sensitive/account') {
        rejected = agent !== undefined;
        status = rejected ? 403 : 200;
        body = rejected ? { error: HTTP_ERROR_BODY } : { ok: true };
      } else if (method === 'GET' && path === '/auth/required') {
        status = request.headers.authorization === 'Bearer fixture-token' ? 200 : 401;
        body = status === 200 ? { ok: true } : { error: HTTP_ERROR_BODY };
      } else if (method === 'GET' && path === '/hang') {
        status = 0;
      }
      requests.push({
        server: name,
        method,
        path,
        origin: request.headers.origin,
        agent: typeof agent === 'string' ? agent : undefined,
        run: request.headers['x-galaxie-run'] as string | undefined,
        requestedMethod: request.headers['access-control-request-method'],
        requestedHeaders: request.headers['access-control-request-headers'],
        status,
        rejected,
      });
      // The timeout fixture records arrival but sends no HTTP response.
      if (status === 0) return;
      if (streaming) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const deltas = toolCall
          ? [
              {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'loopback-tool-id',
                    type: 'function',
                    function: { name: 'echo_1', arguments: '{"q":' },
                  },
                ],
              },
              { tool_calls: [{ index: 0, function: { arguments: '"query"}' } }] },
              {},
            ]
          : [{ role: 'assistant', content: 'loopback ' }, { content: 'reply' }, {}];
        for (const [index, delta] of deltas.entries())
          response.write(
            `data: ${JSON.stringify({
              ...completion,
              object: 'chat.completion.chunk',
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: index === 2 ? (toolCall ? 'tool_calls' : 'stop') : null,
                },
              ],
            })}\n\n`,
          );
        response.write(
          `data: ${JSON.stringify({ ...completion, object: 'chat.completion.chunk', choices: [], usage })}\n\n`,
        );
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(status === 204 ? undefined : JSON.stringify(body));
    }),
  );
  const [cors, noCors] = servers;
  if (cors === undefined || noCors === undefined) throw new Error('Missing HTTP test server.');
  const corsUrl = await listen(cors);
  let noCorsUrl: string;
  try {
    noCorsUrl = await listen(noCors);
  } catch (error) {
    await close(cors);
    throw error;
  }
  const closed = createServer();
  const closedUrl = await listen(closed);
  await close(closed);
  return {
    fixture: { corsUrl, noCorsUrl, closedUrl, adminUrl: `${corsUrl}/__admin` },
    async close(): Promise<void> {
      await Promise.all(servers.map(close));
    },
  };
}
