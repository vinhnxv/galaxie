// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig, type UserConfigExport } from 'vite';
import { cspHeader } from './src/csp.js';
import { frameworkProfile } from './src/framework-profile.js';
import framework from './vite.framework.js';

const config: UserConfigExport = defineConfig(({ mode }) =>
  mergeConfig(framework, {
    root: fileURLToPath(new URL('.', import.meta.url)),
    worker: { format: 'es' },
    oxc: { jsx: { runtime: 'automatic' } },
    server: { headers: { 'Content-Security-Policy': cspHeader(mode, frameworkProfile.workers) } },
    preview: { headers: { 'Content-Security-Policy': cspHeader(mode, frameworkProfile.workers) } },
  }),
);

export default config;
