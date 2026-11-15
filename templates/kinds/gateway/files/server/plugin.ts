// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createGateway, type GatewayOptions } from './gateway.js';

export function gatewayPlugin(options: GatewayOptions = {}): Plugin {
  const gateway = createGateway(options);
  const middleware = (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): void => {
    const path = request.url?.split('?')[0] ?? '';
    if (path === '/api' || path.startsWith('/api/')) void gateway.handle(request, response);
    else next();
  };
  return {
    name: 'hybrid-gateway',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
