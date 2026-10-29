// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

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
  const servers = (['cors', 'no-cors'] as const).map((name) =>
    createServer((request, response) => {
      request.resume();
      if (name === 'cors') {
        response.setHeader('Access-Control-Allow-Origin', HTTP_ORIGIN);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        response.setHeader(
          'Access-Control-Allow-Headers',
          'content-type, authorization, x-galaxie-agent, x-galaxie-run',
        );
      }
      const path = request.url ?? '';
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
      if (method === 'OPTIONS') {
        status = 204;
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
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(status === 204 ? undefined : JSON.stringify(body));
    }),
  );
  const [cors, noCors] = servers;
  if (cors === undefined || noCors === undefined) throw new Error('Missing HTTP test server.');
  const corsUrl = await listen(cors);
  const closed = createServer();
  const closedUrl = await listen(closed);
  await close(closed);
  let noCorsUrl: string;
  try {
    noCorsUrl = await listen(noCors);
  } catch (error) {
    await close(cors);
    throw error;
  }
  return {
    fixture: { corsUrl, noCorsUrl, closedUrl, adminUrl: `${corsUrl}/__admin` },
    async close(): Promise<void> {
      await Promise.all(servers.map(close));
    },
  };
}
