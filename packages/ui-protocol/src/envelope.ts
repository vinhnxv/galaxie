// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { Component, JsonObject } from './messages.js';

export type ProtocolErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNSUPPORTED_VERSION'
  | 'UNSUPPORTED_RENDERER_MESSAGE'
  | 'UNSUPPORTED_AGENT_RESPONSE'
  | 'UNSUPPORTED_THEME'
  | 'DATA_MODEL_REQUIRED'
  | 'UNKNOWN_FIELD'
  | 'BINDING_MISMATCH'
  | 'INTEGRITY_ERROR'
  | 'DUPLICATE_COMPONENT_ID'
  | 'UNKNOWN_COMPONENT'
  | 'INVALID_COMPONENT_PROPERTY'
  | 'MISSING_ROOT'
  | 'UNRESOLVED_REFERENCE'
  | 'CYCLIC_COMPONENTS'
  | 'UNALLOWED_PARENT'
  | 'UNALLOWED_CHILD'
  | 'INVALID_DATA_PATH'
  | 'RESERVED_DATA_KEY'
  | 'URL_BINDING_FORBIDDEN'
  | 'URL_NOT_ALLOWED'
  | 'PRIVATE_VALUE_IN_URL'
  | 'PAYLOAD_TOO_LARGE'
  | 'TOO_MANY_COMPONENTS'
  | 'UNKNOWN_FUNCTION'
  | 'FUNCTION_CALLER_DENIED'
  | 'USER_ACTIVATION_REQUIRED'
  | 'INVALID_FUNCTION_ARGUMENTS'
  | 'EXECUTION_ERROR'
  | 'UNSUPPORTED_AGENT_FUNCTION';

export const PROTOCOL_ERROR_CATEGORY: Readonly<
  Record<ProtocolErrorCode, 'invalid' | 'unsupported' | 'denied' | 'budget_exceeded'>
> = Object.freeze({
  INVALID_MESSAGE: 'invalid',
  UNSUPPORTED_VERSION: 'unsupported',
  UNSUPPORTED_RENDERER_MESSAGE: 'unsupported',
  UNSUPPORTED_AGENT_RESPONSE: 'unsupported',
  UNSUPPORTED_THEME: 'invalid',
  DATA_MODEL_REQUIRED: 'unsupported',
  UNKNOWN_FIELD: 'invalid',
  BINDING_MISMATCH: 'denied',
  INTEGRITY_ERROR: 'invalid',
  DUPLICATE_COMPONENT_ID: 'invalid',
  UNKNOWN_COMPONENT: 'unsupported',
  INVALID_COMPONENT_PROPERTY: 'invalid',
  MISSING_ROOT: 'invalid',
  UNRESOLVED_REFERENCE: 'invalid',
  CYCLIC_COMPONENTS: 'invalid',
  UNALLOWED_PARENT: 'invalid',
  UNALLOWED_CHILD: 'invalid',
  INVALID_DATA_PATH: 'invalid',
  RESERVED_DATA_KEY: 'invalid',
  URL_BINDING_FORBIDDEN: 'denied',
  URL_NOT_ALLOWED: 'denied',
  PRIVATE_VALUE_IN_URL: 'denied',
  PAYLOAD_TOO_LARGE: 'budget_exceeded',
  TOO_MANY_COMPONENTS: 'budget_exceeded',
  UNKNOWN_FUNCTION: 'unsupported',
  FUNCTION_CALLER_DENIED: 'denied',
  USER_ACTIVATION_REQUIRED: 'denied',
  INVALID_FUNCTION_ARGUMENTS: 'invalid',
  EXECUTION_ERROR: 'invalid',
  UNSUPPORTED_AGENT_FUNCTION: 'unsupported',
});

export interface TrustedBinding {
  readonly region: string;
  readonly a2uiSurfaceId: string;
  readonly catalogId: string;
}

export interface MaterializedSurface extends TrustedBinding {
  readonly format: 'galaxie.surface/1';
  readonly revision: number;
  readonly specVersion: string;
  readonly specRevision: string;
  readonly status: 'live' | 'deleted';
  readonly components: Readonly<Record<string, Component>>;
  readonly dataModel: JsonObject;
}

export interface ProtocolFailure {
  readonly ok: false;
  readonly code: ProtocolErrorCode;
  readonly index?: number;
}

export type SurfaceResult =
  | { readonly ok: true; readonly surface: MaterializedSurface }
  | ProtocolFailure;
