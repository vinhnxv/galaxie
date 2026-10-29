// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export const MCP_ORIGIN: string = 'http://127.0.0.1:63315';
export interface McpFixture {
  readonly url: string;
  readonly badUrl: string;
  readonly token: string;
  readonly otherToken: string;
  readonly pins: Readonly<Record<string, string>>;
}
export type McpAction = 'state' | 'description' | 'reset' | 'forget' | 'sampling' | 'bad-origin';
export interface McpAdminState {
  readonly calls: number;
  readonly sessions: number;
  readonly counters: Record<string, number>;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly samplingCode?: number;
  readonly badOriginStatus?: number;
}

export interface McpControl {
  readonly fixture: McpFixture;
  admin(action: McpAction): Promise<McpAdminState>;
  close(): Promise<void>;
}

declare module 'vitest' {
  interface ProvidedContext {
    mcp: McpFixture;
  }
}
declare module 'vitest/browser' {
  interface BrowserCommands {
    mcpAdmin(action: McpAction): Promise<McpAdminState>;
  }
}
