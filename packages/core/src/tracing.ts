// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type Attributes,
  type Context,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import type { CapabilityKind } from './capabilities.js';
import type { ErrorCode, ErrorInfo } from './errors.js';
import type { RunStatus } from './lifecycle.js';
import type { BudgetLimits, DataLabel, DestinationClass } from './policy.js';
import type { RunTrace, TraceHandle, TraceResult } from './trace.js';

// open-telemetry/semantic-conventions-genai@51a0f580f8a6ad804ca4de5e033683c6fbbe5906
// schema_url https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev; core semconv v1.44.0.
const ALLOWED = new Set([
  'gen_ai.operation.name',
  'gen_ai.tool.name',
  'galaxie.capability.kind',
  'galaxie.destination.class',
  'galaxie.model.provider',
  'galaxie.run.labels',
  'galaxie.budget.name',
  'gen_ai.agent.name',
  'galaxie.app.id',
  'galaxie.agent.version',
  'galaxie.instance.id',
  'galaxie.session.id',
  'galaxie.run.id',
  'galaxie.executor.id',
  'galaxie.executor.version',
  'galaxie.run.status',
  'error.type',
  'galaxie.error.code',
  'galaxie.node.name',
  'galaxie.node.step',
  'galaxie.step.status',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
]);
const NOOP_HANDLE: TraceHandle = { end: () => {} };

function safeName(value: string): string {
  return value.length >= 1 && value.length <= 128 && !/\p{Cc}/u.test(value) ? value : '_OTHER';
}

function attributes(values: Readonly<Record<string, unknown>>): Attributes {
  const filtered: Attributes = {};
  for (const [key, value] of Object.entries(values)) {
    if (!ALLOWED.has(key)) continue;
    if (typeof value === 'string') filtered[key] = safeName(value);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
      filtered[key] = value;
    else if (
      Array.isArray(value) &&
      value.every(
        (item) =>
          typeof item === typeof value[0] &&
          (typeof item === 'string' ||
            typeof item === 'boolean' ||
            (typeof item === 'number' && Number.isFinite(item))),
      )
    ) {
      filtered[key] = value.map((item) => (typeof item === 'string' ? safeName(item) : item));
    }
  }
  return filtered;
}

function errorType(value: string | undefined): string {
  return value !== undefined && /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/.test(value) ? value : '_OTHER';
}

export interface RunMetadata {
  readonly appId: string;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly executorId: string;
  readonly executorVersion: string;
}

export type CapabilityResult =
  | { readonly status: 'ok' | 'cancelled' }
  | { readonly status: 'error'; readonly code: ErrorCode };
export interface CapabilitySpan {
  end(result: CapabilityResult): void;
}

export interface RunInstrumentation {
  readonly recorder: RunTrace;
  startCapability(
    meta: {
      readonly name?: string;
      readonly kind?: CapabilityKind;
      readonly destination?: DestinationClass;
    },
    parent?: TraceHandle,
  ): CapabilitySpan;
  setLabels(labels: readonly DataLabel[]): void;
  recordBudget(name: keyof BudgetLimits): void;
  finish(status: RunStatus, error?: ErrorInfo): void;
}

interface StepRecord {
  readonly kind: 'node' | 'model' | 'capability';
  readonly span: Span;
  readonly context: Context;
  readonly depth: number;
  ended: boolean;
}

export function startRunTrace(
  tracer: Tracer,
  parent: Context,
  metadata: RunMetadata,
): RunInstrumentation {
  const root = tracer.startSpan(
    `invoke_agent ${safeName(metadata.agentId)}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: attributes({
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': metadata.agentId,
        'galaxie.app.id': metadata.appId,
        'galaxie.agent.version': metadata.agentVersion,
        'galaxie.instance.id': metadata.instanceId,
        'galaxie.session.id': metadata.sessionId,
        'galaxie.run.id': metadata.runId,
        'galaxie.executor.id': metadata.executorId,
        'galaxie.executor.version': metadata.executorVersion,
      }),
    },
    parent,
  );
  const rootContext = trace.setSpan(parent, root);
  const steps = new Map<object, StepRecord>();
  const labels: { value: readonly DataLabel[] } = { value: [] };
  let closed = false;
  const end = (record: StepRecord, result: TraceResult | CapabilityResult): void => {
    if (record.ended) return;
    record.ended = true;
    record.span.setAttributes(
      attributes({
        'galaxie.step.status': result.status,
        ...(record.kind === 'model' && 'route' in result && result.route !== undefined
          ? {
              'galaxie.destination.class': result.route.destination,
              'galaxie.model.provider': result.route.providerId,
            }
          : {}),
        ...(result.status === 'error'
          ? record.kind === 'capability'
            ? {
                'error.type': 'GalaxieError',
                'galaxie.error.code': 'code' in result ? result.code : 'cancelled',
              }
            : { 'error.type': errorType('errorType' in result ? result.errorType : undefined) }
          : {}),
        ...(result.status === 'ok' && record.kind === 'model'
          ? {
              'gen_ai.response.model': 'responseModel' in result ? result.responseModel : undefined,
              'gen_ai.usage.input_tokens':
                'usage' in result ? result.usage?.inputTokens : undefined,
              'gen_ai.usage.output_tokens':
                'usage' in result ? result.usage?.outputTokens : undefined,
            }
          : {}),
      }),
    );
    if (result.status === 'error') record.span.setStatus({ code: SpanStatusCode.ERROR });
    record.span.end();
  };
  return {
    recorder: {
      start(step, parentHandle): TraceHandle {
        if (closed) return NOOP_HANDLE;
        const ancestor = parentHandle === undefined ? undefined : steps.get(parentHandle);
        const name =
          step.kind === 'node'
            ? `galaxie.node ${safeName(step.name)}`
            : step.model === undefined
              ? 'chat'
              : `chat ${safeName(step.model)}`;
        const span = tracer.startSpan(
          name,
          {
            kind: step.kind === 'node' ? SpanKind.INTERNAL : SpanKind.CLIENT,
            attributes: attributes(
              step.kind === 'node'
                ? {
                    'galaxie.node.name': step.name,
                    'galaxie.node.step': step.step,
                  }
                : {
                    'gen_ai.operation.name': 'chat',
                    'gen_ai.provider.name': step.provider ?? '_OTHER',
                    'gen_ai.request.model': step.model,
                    'galaxie.destination.class': step.route?.destination,
                    'galaxie.model.provider': step.route?.providerId,
                  },
            ),
          },
          ancestor?.context ?? rootContext,
        );
        const record: StepRecord = {
          kind: step.kind,
          span,
          context: trace.setSpan(ancestor?.context ?? rootContext, span),
          depth: (ancestor?.depth ?? 0) + 1,
          ended: false,
        };
        const handle: TraceHandle = {
          end(result): void {
            if (!closed) end(record, result);
          },
        };
        steps.set(handle, record);
        return handle;
      },
    },
    startCapability(meta, parentHandle): CapabilitySpan {
      if (closed) return { end: () => {} };
      const ancestor = parentHandle === undefined ? undefined : steps.get(parentHandle);
      const span = tracer.startSpan(
        meta.name === undefined ? 'execute_tool' : `execute_tool ${safeName(meta.name)}`,
        {
          kind: SpanKind.INTERNAL,
          attributes: attributes({
            'gen_ai.operation.name': 'execute_tool',
            'gen_ai.tool.name': meta.name,
            'galaxie.capability.kind': meta.kind,
            'galaxie.destination.class': meta.destination,
          }),
        },
        ancestor?.context ?? rootContext,
      );
      const record: StepRecord = {
        kind: 'capability',
        span,
        context: trace.setSpan(ancestor?.context ?? rootContext, span),
        depth: (ancestor?.depth ?? 0) + 1,
        ended: false,
      };
      const handle: CapabilitySpan = {
        end(result): void {
          if (!closed) end(record, result);
        },
      };
      steps.set(handle, record);
      return handle;
    },
    setLabels(value): void {
      if (!closed) labels.value = [...value].sort();
    },
    recordBudget(name): void {
      if (!closed) root.setAttributes(attributes({ 'galaxie.budget.name': name }));
    },
    finish(status, error): void {
      if (closed) return;
      closed = true;
      const result =
        status === 'cancelled'
          ? { status: 'cancelled' as const }
          : status === 'failed'
            ? { status: 'error' as const, errorType: errorType(error?.type) }
            : { status: 'ok' as const };
      for (const record of [...steps.values()]
        .filter((record) => !record.ended)
        .sort((a, b) => b.depth - a.depth))
        end(record, record.kind === 'capability' ? { status: 'cancelled' } : result);
      root.setAttributes(
        attributes({
          'galaxie.run.status': status,
          'galaxie.run.labels': labels.value,
          ...(status === 'failed'
            ? { 'error.type': errorType(error?.type), 'galaxie.error.code': error?.code }
            : {}),
        }),
      );
      if (status === 'failed') root.setStatus({ code: SpanStatusCode.ERROR });
      root.end();
      steps.clear();
    },
  };
}
