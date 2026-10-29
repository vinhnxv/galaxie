// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { TestProject } from 'vitest/node';
import { startMcpServer } from '../../../examples/mcp-server/src/index.js';
import { toolPin } from '../../../packages/tools-mcp/src/index.js';
import { mcpFixtures } from './mcp-commands.node.js';
import { MCP_ORIGIN, type McpAdminState, type McpControl } from './mcp-context.js';

export async function createFixture(): Promise<McpControl> {
  const token = crypto.randomUUID();
  const otherToken = crypto.randomUUID();
  const verifyToken = (value: string): string | undefined =>
    value === token ? 'one' : value === otherToken ? 'two' : undefined;
  const server = await startMcpServer({ allowedOrigins: [MCP_ORIGIN], verifyToken });
  const badServer = await startMcpServer({ allowedOrigins: ['http://127.0.0.1:1'], verifyToken });
  const pins: Record<string, string> = {};
  for (const tool of server.admin.tools()) pins[tool.name] = await toolPin(tool);
  return {
    fixture: { url: server.url, badUrl: badServer.url, token, otherToken, pins },
    async admin(action): Promise<McpAdminState> {
      if (action === 'description')
        await server.admin.changeDescription('lesson.lookup', 'metadata-canary');
      if (action === 'reset') {
        await server.admin.forgetSessions();
        await server.admin.changeDescription('lesson.lookup', 'Look up a lesson.');
      }
      if (action === 'forget') await server.admin.forgetSessions();
      if (action === 'sampling') server.admin.requestSampling();
      return {
        calls: server.admin.callCount(),
        sessions: server.admin.sessionCount(),
        counters: server.admin.counters(),
        headers: server.admin.lastHeaders(),
        ...(server.admin.samplingCode() === undefined
          ? {}
          : { samplingCode: server.admin.samplingCode() as number }),
        ...(action !== 'bad-origin'
          ? {}
          : {
              badOriginStatus: (
                await fetch(badServer.url, {
                  headers: { origin: MCP_ORIGIN, authorization: `Bearer ${token}` },
                })
              ).status,
            }),
      };
    },
    async close(): Promise<void> {
      await Promise.all([server.close(), badServer.close()]);
    },
  };
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const control = await createFixture();
  mcpFixtures(project).set(control.fixture.url, control);
  project.provide('mcp', control.fixture);
  return async (): Promise<void> => {
    mcpFixtures(project).delete(control.fixture.url);
    await control.close();
  };
}
