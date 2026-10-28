// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' https://huggingface.co https://*.hf.co https://raw.githubusercontent.com",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
].join('; ');
const lan = process.env['VITE_LAN'] === '1';
export default defineConfig({
  plugins: lan ? [basicSsl()] : [],
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
