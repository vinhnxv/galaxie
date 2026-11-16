// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { GatewayOptions } from './gateway.js';
import { createMockUpstream } from './mock-upstream.js';
import { gatewayOptionsFromEnvironment } from './serve.js';

/** Dev and preview only; partial upstream configuration must remain unavailable. */
export function devGatewayOptions(): GatewayOptions {
  if (process.env['UPSTREAM_BASE_URL'] || process.env['UPSTREAM_API_KEY']) {
    return gatewayOptionsFromEnvironment();
  }
  return { mockUpstream: createMockUpstream() };
}
