// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type ErrorCode, GalaxieError, toErrorInfo } from '@galaxie-ai/core';

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
