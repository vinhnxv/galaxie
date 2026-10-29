// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

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
