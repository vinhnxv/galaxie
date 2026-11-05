// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export const MCP_ORIGIN: string = 'http://127.0.0.1:63315';
export interface McpFixture {
  readonly url: string;
  readonly badUrl: string;
  readonly token: string;
  readonly otherToken: string;
  readonly pins: Readonly<Record<string, string>>;
}
export type McpAction =
  | 'state'
  | 'description'
  | 'reset'
  | 'forget'
  | 'sampling'
  | 'elicitation'
  | 'bad-origin'
  | { readonly kind: 'set-description'; readonly description: string };
export interface McpAdminState {
  readonly calls: number;
  readonly meta: Record<string, unknown>;
  readonly sessions: number;
  readonly counters: Record<string, number>;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly samplingCode?: number;
  readonly elicitationCode?: number;
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
    mcpCorpus: McpFixture;
  }
}
declare module 'vitest/browser' {
  interface BrowserCommands {
    mcpAdmin(action: McpAction): Promise<McpAdminState>;
    mcpCorpusAdmin(action: McpAction): Promise<McpAdminState>;
  }
}
