// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cspHeader } from '../src/csp.js';
import { createGateway, type Gateway, type GatewayOptions } from './gateway.js';

/** The only environment-reading boundary; Vite imports this on the server side only. */
export function gatewayOptionsFromEnvironment(): GatewayOptions {
  const baseURL = process.env['UPSTREAM_BASE_URL'];
  const apiKey = process.env['UPSTREAM_API_KEY'];
  return baseURL && apiKey ? { upstream: { baseURL, apiKey } } : {};
}

/** Serve a built copy from its template directory; API requests never fall through to files. */
export function createAppHandler(
  gateway: Gateway,
  directory: string = resolve('dist'),
): (request: IncomingMessage, response: ServerResponse) => void {
  const root = resolve(directory);
  const types: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
  };
  return (request, response): void => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('Content-Security-Policy', cspHeader());
    const route = request.url?.split('?')[0] ?? '';
    if (route === '/api' || route.startsWith('/api/')) {
      void gateway.handle(request, response);
      return;
    }
    void (async () => {
      try {
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new Error('not_found');
        const path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
        const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
        if (!file.startsWith(`${root}${sep}`)) throw new Error('not_found');
        const bytes = await readFile(file);
        response.writeHead(200, {
          'content-type': types[extname(file)] ?? 'application/octet-stream',
        });
        response.end(request.method === 'HEAD' ? undefined : bytes);
      } catch {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"error":"not_found"}');
      }
    })();
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer(createAppHandler(createGateway(gatewayOptionsFromEnvironment()))).listen(
    4173,
    '127.0.0.1',
  );
}
