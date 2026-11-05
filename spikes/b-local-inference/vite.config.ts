// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';

const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' https://huggingface.co https://*.hf.co https://raw.githubusercontent.com",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
].join('; ');
const lan = process.env['VITE_LAN'] === '1';
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
// Dev only, loopback only: a real run on this machine saves its export into results/ without a
// browser download. Not served in LAN mode or in a build.
function saveResults(): Plugin {
  const dir = fileURLToPath(new URL('./results/', import.meta.url));
  return {
    name: 'spike-b-save-results',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__spike-b/save', (req, res) => {
        const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? '';
        if (
          req.method !== 'POST' ||
          !/^[a-z0-9-]{1,80}$/.test(name) ||
          !loopback.has(req.socket.remoteAddress ?? '')
        ) {
          res.statusCode = 403;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 5_000_000) req.destroy();
          else chunks.push(chunk);
        });
        req.on('end', () => {
          void (async () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
                schema?: unknown;
              };
              if (value.schema !== 'galaxie.spike-b.results/v1') throw new Error('schema');
              await mkdir(dir, { recursive: true });
              await writeFile(`${dir}${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
              res.statusCode = 204;
            } catch {
              res.statusCode = 400;
            }
            res.end();
          })();
        });
      });
    },
  };
}
export default defineConfig({
  plugins: lan ? [basicSsl()] : [saveResults()],
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    host: lan ? true : '127.0.0.1',
    port: lan ? 4443 : 4173,
    strictPort: true,
    headers: { 'Content-Security-Policy': csp },
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web', '@huggingface/transformers'] },
});
