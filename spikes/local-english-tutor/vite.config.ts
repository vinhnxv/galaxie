// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The page and its worker may connect only to this server and to huggingface.co, whose large files
// redirect to a *.hf.co CDN host. 'wasm-unsafe-eval' lets onnxruntime-web compile its WebAssembly.
// The inline script and styles are Vite's dev client and React Refresh, which this dev-only spike
// needs.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' https://huggingface.co https://*.hf.co",
].join('; ');

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // The origin of spikes/b0-webgpu-load, so the model it cached is reused.
    port: 4173,
    strictPort: true,
    // Vite sends these headers with every response, the worker script included, so the policy
    // applies inside the worker too.
    headers: { 'Content-Security-Policy': CONTENT_SECURITY_POLICY },
  },
  // onnxruntime-web finds its .wasm files next to its own module, so it must not be pre-bundled.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
});
