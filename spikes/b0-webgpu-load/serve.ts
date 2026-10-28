// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

// Serves this spike at http://127.0.0.1:4173/ (or $PORT): the page, its script and the installed
// packages in node_modules. Chrome treats 127.0.0.1 as a secure context, so WebGPU is available.

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, sep } from 'node:path';

const root = await realpath(import.meta.dirname);
const port = Number(process.env.PORT ?? 4173);
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
};

createServer(async (request, response) => {
  try {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    // realpath follows pnpm's symlinks; the result must still be inside this directory.
    const file = await realpath(join(root, path));
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) {
      throw new Error(`not served: ${path}`);
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Serving ${root} at http://127.0.0.1:${port}/`);
});
