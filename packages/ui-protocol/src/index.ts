// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export type {
  MaterializedSurface,
  ProtocolErrorCode,
  ProtocolFailure,
  SurfaceResult,
  TrustedBinding,
} from './envelope.js';
export { PROTOCOL_ERROR_CATEGORY } from './envelope.js';
export type {
  Component,
  CreateSurface,
  DeleteSurface,
  JsonObject,
  JsonValue,
  Message,
  Metadata,
  ParseResult,
  RegisteredExtensions,
  SyncSchema,
  UpdateComponents,
  UpdateDataModel,
} from './messages.js';
export { A2UI_SPEC_REVISION, A2UI_SPEC_VERSION, parseMessage } from './messages.js';
export { reduceBatch, validateSurface } from './surface.js';
export type {
  Catalog,
  CatalogComponent,
  CatalogFunction,
  SurfaceContext,
  ValidationOptions,
} from './validate.js';
