// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { type ErrorCode, GalaxieError, toErrorInfo } from '@galaxie/core';

export type McpEventCode =
  | 'mcp_pin_mismatch'
  | 'mcp_tool_missing'
  | 'mcp_protocol_mismatch'
  | 'mcp_session_reset'
  | 'mcp_server_request_rejected'
  | 'mcp_limit_exceeded'
  | 'mcp_tool_error'
  | 'mcp_unauthorized';
export interface McpEvent {
  readonly code: McpEventCode;
  readonly server: string;
  readonly tool?: string;
  readonly method?: string;
}
export function failure(code: ErrorCode = 'unavailable'): GalaxieError {
  return new GalaxieError(code, toErrorInfo(code).message);
}
