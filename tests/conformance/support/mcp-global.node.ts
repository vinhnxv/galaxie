// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { BrowserCommand, TestProject } from 'vitest/node';
import { startMcpServer } from '../../../examples/mcp-server/src/index.js';
import { toolPin } from '../../../packages/tools-mcp/src/index.js';
import { MCP_ORIGIN, type McpAction, type McpAdminState, type McpFixture } from './mcp-context.js';

export interface McpControl {
  readonly fixture: McpFixture;
  admin(action: McpAction): Promise<McpAdminState>;
  close(): Promise<void>;
}
function fixtures(project: TestProject): Map<string, McpControl> {
  const registry = project.vitest as unknown as Record<symbol, Map<string, McpControl> | undefined>;
  const key = Symbol.for('galaxie.mcp.test-fixtures');
  let controls = registry[key];
  if (controls === undefined) {
    controls = new Map();
    registry[key] = controls;
  }
  return controls;
}

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
  fixtures(project).set(control.fixture.url, control);
  project.provide('mcp', control.fixture);
  return async (): Promise<void> => {
    fixtures(project).delete(control.fixture.url);
    await control.close();
  };
}

export const mcpAdminCommand: BrowserCommand<[McpAction], McpAdminState> = async (
  { project },
  action,
) => {
  const fixture = project.getProvidedContext().mcp;
  const control = fixtures(project).get(fixture.url);
  if (control === undefined) throw new Error('MCP test fixture is unavailable.');
  return control.admin(action);
};
