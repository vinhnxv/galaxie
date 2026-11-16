// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { NextConfig } from 'next';

const config: NextConfig = {
  agentRules: false,
  poweredByHeader: false,
  turbopack: {
    rules: {
      '*.{ts,tsx}': { loaders: ['./src/relative-imports.cjs'] },
    },
  },
  distDir: process.env['GALAXIE_NEXT_DIST_DIR'] ?? '.next',
  env: { ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'false' },
  experimental: { extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
};
export default config;
