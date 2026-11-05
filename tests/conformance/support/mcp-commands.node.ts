// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { BrowserCommand, TestProject } from 'vitest/node';
import type { McpAction, McpAdminState, McpControl } from './mcp-context.js';

export function mcpFixtures(project: TestProject): Map<string, McpControl> {
  const registry = project.vitest as unknown as Record<symbol, Map<string, McpControl> | undefined>;
  const key = Symbol.for('galaxie.mcp.test-fixtures');
  let controls = registry[key];
  if (controls === undefined) {
    controls = new Map();
    registry[key] = controls;
  }
  return controls;
}

export const mcpAdminCommand: BrowserCommand<[McpAction], McpAdminState> = async (
  { project },
  action,
) => {
  const fixture = project.getProvidedContext().mcp;
  const control = mcpFixtures(project).get(fixture.url);
  if (control === undefined) throw new Error('MCP test fixture is unavailable.');
  return control.admin(action);
};

export const mcpCorpusAdminCommand: BrowserCommand<[McpAction], McpAdminState> = async (
  { project },
  action,
) => {
  const fixture = project.getProvidedContext().mcpCorpus;
  const control = mcpFixtures(project).get(fixture.url);
  if (control === undefined) throw new Error('Corpus MCP test fixture is unavailable.');
  return control.admin(action);
};
