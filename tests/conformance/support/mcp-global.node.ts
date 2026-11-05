// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { TestProject } from 'vitest/node';
import { startMcpServer } from '../../../examples/mcp-server/src/index.js';
import { toolPin } from '../../../packages/tools-mcp/src/index.js';
import { createHttpFixture } from './http-fixture.node.js';
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
      if (typeof action === 'object' && action.kind === 'set-description')
        await server.admin.changeDescription('lesson.lookup', action.description);
      if (action === 'description')
        await server.admin.changeDescription('lesson.lookup', 'metadata-canary');
      if (action === 'reset') {
        await server.admin.forgetSessions();
        await server.admin.changeDescription('lesson.lookup', 'Look up a lesson.');
      }
      if (action === 'forget') await server.admin.forgetSessions();
      if (action === 'sampling') server.admin.requestSampling();
      if (action === 'elicitation') server.admin.requestElicitation();
      return {
        calls: server.admin.callCount(),
        meta: server.admin.lastMeta(),
        sessions: server.admin.sessionCount(),
        counters: server.admin.counters(),
        headers: server.admin.lastHeaders(),
        ...(server.admin.samplingCode() === undefined
          ? {}
          : { samplingCode: server.admin.samplingCode() as number }),
        ...(server.admin.elicitationCode() === undefined
          ? {}
          : { elicitationCode: server.admin.elicitationCode() as number }),
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
  const corpus = await createFixture();
  const http = await createHttpFixture();
  const openaiHttp = await createHttpFixture();
  mcpFixtures(project).set(control.fixture.url, control);
  mcpFixtures(project).set(corpus.fixture.url, corpus);
  project.provide('mcp', control.fixture);
  project.provide('mcpCorpus', corpus.fixture);
  project.provide('http', http.fixture);
  project.provide('openaiHttp', openaiHttp.fixture);
  return async (): Promise<void> => {
    mcpFixtures(project).delete(control.fixture.url);
    mcpFixtures(project).delete(corpus.fixture.url);
    await Promise.all([control.close(), corpus.close(), http.close(), openaiHttp.close()]);
  };
}
