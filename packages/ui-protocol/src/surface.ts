// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type { MaterializedSurface, ProtocolFailure, SurfaceResult } from './envelope.js';
import {
  arrayIndex,
  copyJson,
  isObject,
  jsonBytes,
  pointerParts,
  resolvePath,
  setOwn,
} from './json.js';
import type { Component, JsonObject, JsonValue, Message } from './messages.js';
import {
  A2UI_SPEC_REVISION,
  A2UI_SPEC_VERSION,
  hasAgentFunction,
  onlyKeys,
  parseMessage,
} from './messages.js';
import type { SurfaceContext } from './validate.js';
import { validateCandidate } from './validate.js';

function bindingFailure(
  surface: MaterializedSurface,
  context: SurfaceContext,
): ProtocolFailure | undefined {
  const { binding, catalog } = context;
  if (
    surface.region !== binding.region ||
    surface.a2uiSurfaceId !== binding.a2uiSurfaceId ||
    surface.catalogId !== binding.catalogId ||
    catalog.id !== binding.catalogId
  )
    return { ok: false, code: 'BINDING_MISMATCH' };
  const mismatched = (value: JsonValue): boolean => {
    if (Array.isArray(value)) return value.some(mismatched);
    return (
      isObject(value) &&
      ((Object.hasOwn(value, '@call') &&
        Object.hasOwn(value, 'catalogId') &&
        value['catalogId'] !== binding.catalogId) ||
        Object.values(value).some(mismatched))
    );
  };
  for (const component of Object.values(surface.components)) {
    if (
      (component['catalogId'] !== undefined && component['catalogId'] !== binding.catalogId) ||
      Object.entries(component).some(([key, value]) => key !== 'metadata' && mismatched(value))
    )
      return { ok: false, code: 'BINDING_MISMATCH' };
  }
  return undefined;
}

function updateModel(model: JsonObject, path: string, value: JsonValue): JsonObject | undefined {
  if (path === '/' || path === '') return isObject(value) ? value : undefined;
  const parts = pointerParts(path);
  const key = parts?.pop();
  if (parts === undefined || key === undefined) return undefined;
  let parent: JsonValue = model;
  for (const part of parts) {
    if (isObject(parent) && !Object.hasOwn(parent, part)) {
      if (value === null) return model;
      setOwn(parent, part, {});
    }
    const next = resolvePath(parent, [part]);
    if (next === undefined) return undefined;
    parent = next;
  }
  if (Array.isArray(parent)) {
    const index = arrayIndex(key, parent.length);
    if (index === undefined) return undefined;
    const mutable = parent as JsonValue[];
    if (value === null) mutable.splice(index, 1);
    else setOwn(mutable, key, value);
  } else if (isObject(parent)) {
    if (value === null) delete (parent as Record<string, JsonValue>)[key];
    else setOwn(parent, key, value);
  } else return undefined;
  return model;
}

/** Revalidates and detaches stored data. Restore never silently changes a specification pin. */
function readStored(surface: unknown): SurfaceResult {
  let value: JsonValue;
  try {
    value = copyJson(surface);
  } catch {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
  if (!isObject(value)) return { ok: false, code: 'INVALID_MESSAGE' };
  if (value['specVersion'] !== A2UI_SPEC_VERSION || value['specRevision'] !== A2UI_SPEC_REVISION) {
    return { ok: false, code: 'UNSUPPORTED_VERSION' };
  }
  if (
    !onlyKeys(value, [
      'format',
      'region',
      'a2uiSurfaceId',
      'catalogId',
      'revision',
      'specVersion',
      'specRevision',
      'status',
      'components',
      'dataModel',
    ])
  )
    return { ok: false, code: 'UNKNOWN_FIELD' };
  if (
    value['format'] !== 'galaxie.surface/1' ||
    typeof value['region'] !== 'string' ||
    typeof value['a2uiSurfaceId'] !== 'string' ||
    typeof value['catalogId'] !== 'string' ||
    typeof value['revision'] !== 'number' ||
    !Number.isSafeInteger(value['revision']) ||
    value['revision'] < 1 ||
    !['live', 'deleted'].includes(String(value['status'])) ||
    !isObject(value['components']) ||
    !isObject(value['dataModel'])
  )
    return { ok: false, code: 'INVALID_MESSAGE' };
  for (const [id, component] of Object.entries(value['components'])) {
    if (
      !isObject(component) ||
      component['id'] !== id ||
      id.length === 0 ||
      typeof component['component'] !== 'string'
    )
      return { ok: false, code: 'INVALID_MESSAGE' };
    if (hasAgentFunction(component)) return { ok: false, code: 'UNSUPPORTED_AGENT_FUNCTION' };
  }
  const candidate = value as unknown as MaterializedSurface;
  return { ok: true, surface: candidate };
}

/** Revalidates a detached materialized record against the current pin and host policy. */
export function validateSurface(surface: unknown, context: SurfaceContext): SurfaceResult {
  try {
    const stored = readStored(surface);
    if (!stored.ok) return stored;
    const error =
      bindingFailure(stored.surface, context) ?? validateCandidate(stored.surface, context);
    return error ?? stored;
  } catch {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
}

/** Applies wire-order operations to a private candidate and returns only a fully validated result. */
export function reduceBatch(
  previous: MaterializedSurface | undefined,
  messages: readonly unknown[],
  context: SurfaceContext,
): SurfaceResult {
  try {
    return reduceCandidateBatch(previous, messages, context);
  } catch {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
}

function reduceCandidateBatch(
  previous: MaterializedSurface | undefined,
  messages: readonly unknown[],
  context: SurfaceContext,
): SurfaceResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
  let batch: readonly JsonValue[];
  try {
    batch = copyJson(messages) as readonly JsonValue[];
  } catch {
    return { ok: false, code: 'INVALID_MESSAGE' };
  }
  const parsed: Message[] = [];
  for (let index = 0; index < batch.length; index++) {
    const result = parseMessage(batch[index], context.extensions);
    if (!result.ok) return { ...result, index };
    parsed.push(result.message);
  }
  for (let index = 0; index < parsed.length; index++) {
    const message = parsed[index] as Message;
    const payload =
      'createSurface' in message
        ? message.createSurface
        : 'updateComponents' in message
          ? message.updateComponents
          : 'updateDataModel' in message
            ? message.updateDataModel
            : message.deleteSurface;
    if (
      payload.surfaceId !== context.binding.a2uiSurfaceId ||
      ('catalogId' in payload && payload.catalogId !== context.binding.catalogId)
    )
      return { ok: false, code: 'BINDING_MISMATCH', index };
    const list =
      'createSurface' in message
        ? message.createSurface.components
        : 'updateComponents' in message
          ? message.updateComponents.components
          : undefined;
    for (const component of list ?? []) {
      if (
        component['catalogId'] !== undefined &&
        component['catalogId'] !== context.binding.catalogId
      )
        return { ok: false, code: 'BINDING_MISMATCH', index };
    }
  }
  if (context.catalog.id !== context.binding.catalogId) {
    return { ok: false, code: 'BINDING_MISMATCH' };
  }
  let candidate: MaterializedSurface | undefined;
  if (previous !== undefined) {
    const restored = readStored(previous);
    if (!restored.ok) return restored;
    const error = bindingFailure(restored.surface, context);
    if (error !== undefined) return error;
    candidate = restored.surface;
  }
  if (jsonBytes(parsed) > context.limits.payloadBytes) {
    return { ok: false, code: 'PAYLOAD_TOO_LARGE' };
  }
  const revision = (candidate?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) return { ok: false, code: 'INTEGRITY_ERROR' };
  let duplicates = false;
  for (let index = 0; index < parsed.length; index++) {
    const message = parsed[index] as Message;
    if ('createSurface' in message) {
      if (candidate?.status === 'live') return { ok: false, code: 'INTEGRITY_ERROR', index };
      const payload = message.createSurface;
      candidate = {
        format: 'galaxie.surface/1',
        ...context.binding,
        revision,
        specVersion: A2UI_SPEC_VERSION,
        specRevision: A2UI_SPEC_REVISION,
        status: 'live',
        dataModel: payload.dataModel ?? {},
        components: {},
      };
    } else if (candidate === undefined || candidate.status === 'deleted') {
      return { ok: false, code: 'INTEGRITY_ERROR', index };
    }
    if (candidate === undefined) return { ok: false, code: 'INTEGRITY_ERROR', index };
    if ('deleteSurface' in message) {
      candidate = { ...candidate, status: 'deleted', components: {}, dataModel: {} };
    } else if ('updateDataModel' in message) {
      const model = updateModel(
        candidate.dataModel,
        message.updateDataModel.path ?? '/',
        message.updateDataModel.value,
      );
      if (model === undefined) return { ok: false, code: 'INVALID_DATA_PATH', index };
      candidate = { ...candidate, dataModel: model };
    } else {
      const list =
        'createSurface' in message
          ? (message.createSurface.components ?? [])
          : message.updateComponents.components;
      const ids = new Set<string>();
      const components = candidate.components as Record<string, Component>;
      for (const component of list) {
        if (ids.has(component.id)) duplicates = true;
        ids.add(component.id);
        setOwn(components, component.id, component);
      }
    }
  }
  if (candidate === undefined) return { ok: false, code: 'INVALID_MESSAGE' };
  candidate = { ...candidate, revision };
  const error =
    bindingFailure(candidate, context) ?? validateCandidate(candidate, context, duplicates);
  return error ?? { ok: true, surface: candidate };
}
