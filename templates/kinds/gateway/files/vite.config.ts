// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig, type UserConfigExport } from 'vite';
import { devGatewayOptions } from './server/dev.js';
import { gatewayPlugin } from './server/plugin.js';
import { cspHeader } from './src/csp.js';
import framework from './vite.framework.js';

const config: UserConfigExport = defineConfig(
  mergeConfig(framework, {
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [gatewayPlugin(devGatewayOptions())],
    oxc: { jsx: { runtime: 'automatic' } },
    server: { host: '127.0.0.1', headers: { 'Content-Security-Policy': cspHeader() } },
    preview: { host: '127.0.0.1', headers: { 'Content-Security-Policy': cspHeader() } },
  }),
);

export default config;
