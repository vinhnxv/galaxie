// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfigExport } from 'vite';
import { gatewayPlugin } from './server/plugin.js';
import { gatewayOptionsFromEnvironment } from './server/serve.js';
import { cspHeader } from './src/csp.js';

const config: UserConfigExport = defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [gatewayPlugin(gatewayOptionsFromEnvironment())],
  oxc: { jsx: { runtime: 'automatic' } },
  server: { host: '127.0.0.1', headers: { 'Content-Security-Policy': cspHeader() } },
  preview: { host: '127.0.0.1', headers: { 'Content-Security-Policy': cspHeader() } },
});

export default config;
