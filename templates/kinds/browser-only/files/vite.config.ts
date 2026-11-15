// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfigExport } from 'vite';
import { cspHeader } from './src/csp.js';

const config: UserConfigExport = defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  worker: { format: 'es' },
  oxc: { jsx: { runtime: 'automatic' } },
  server: { headers: { 'Content-Security-Policy': cspHeader(mode) } },
  preview: { headers: { 'Content-Security-Policy': cspHeader(mode) } },
}));

export default config;
