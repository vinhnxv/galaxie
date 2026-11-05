// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type Context, context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  StackContextManager,
  TracerProvider,
} from '@opentelemetry/sdk-trace';

export interface RecordedSpan {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly events: readonly { name: string; attributes: Readonly<Record<string, unknown>> }[];
  readonly status: { code: number; message?: string };
}

export interface SpanRecorder {
  spans(): RecordedSpan[];
  dispose(): Promise<void>;
}

/**
 * Keeps the context active until a returned promise settles. There is no AsyncLocalStorage in a
 * page, and ADK writes span attributes after awaits. Suitable for one sequential flow only.
 */
class SequentialContextManager extends StackContextManager {
  override with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context | null,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const previous = this._currentContext;
    this._currentContext = activeContext ?? ROOT_CONTEXT;
    let result: ReturnType<F>;
    try {
      result = fn.call(thisArg, ...args);
    } catch (error) {
      this._currentContext = previous;
      throw error;
    }
    if (typeof (result as { then?: unknown } | null)?.then === 'function') {
      const restore = (): void => {
        this._currentContext = previous;
      };
      (result as unknown as Promise<unknown>).then(restore, restore);
    } else {
      this._currentContext = previous;
    }
    return result;
  }
}

/**
 * Registers a global in-memory tracer provider and a context manager the way a host does
 * (docs/guides/tracing.md). The ADK bundle takes its tracer when it is evaluated, so call this
 * before the first import of `@google/adk`.
 */
export function recordSpans(): SpanRecorder {
  trace.disable();
  context.disable();
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new SequentialContextManager().enable());
  return {
    spans: () =>
      exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: { ...span.attributes },
        events: span.events.map((event) => ({
          name: event.name,
          attributes: { ...event.attributes },
        })),
        status: { ...span.status },
      })),
    dispose: async () => {
      trace.disable();
      context.disable();
      await provider.shutdown();
    },
  };
}
