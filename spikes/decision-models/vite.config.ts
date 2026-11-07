// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Adapted from spikes/b-local-inference/vite.config.ts: loopback server and response CSP.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' https://huggingface.co https://*.hf.co https://raw.githubusercontent.com",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    headers: { 'Content-Security-Policy': csp },
  },
  preview: { host: '127.0.0.1', headers: { 'Content-Security-Policy': csp } },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
