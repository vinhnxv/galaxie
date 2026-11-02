// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type Context,
  type ContextManager,
  context,
  ROOT_CONTEXT,
  trace,
} from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';

export interface RecordedSpan {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export interface SpanRecorder {
  spans(): RecordedSpan[];
  dispose(): Promise<void>;
}

/**
 * A minimal context manager for a single sequential flow, without AsyncLocalStorage (absent in a
 * page). The context stays active until the callback, or the promise it returns, settles. ADK binds
 * the active context around every step of its async generators, and writes span attributes after
 * awaits, so a plain stack would already be empty by then. This is test support, not a model for
 * concurrent flows.
 */
class SequentialContextManager implements ContextManager {
  private current: Context = ROOT_CONTEXT;

  active(): Context {
    return this.current;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const previous = this.current;
    this.current = activeContext;
    let result: ReturnType<F>;
    try {
      result = fn.call(thisArg, ...args);
    } catch (error) {
      this.current = previous;
      throw error;
    }
    if (typeof (result as { then?: unknown } | null)?.then === 'function') {
      const restore = (): void => {
        this.current = previous;
      };
      (result as unknown as Promise<unknown>).then(restore, restore);
    } else {
      this.current = previous;
    }
    return result;
  }

  bind<T>(activeContext: Context, target: T): T {
    if (typeof target !== 'function') return target;
    const bound = (...args: unknown[]): unknown =>
      this.with(activeContext, target as (...args: unknown[]) => unknown, undefined, ...args);
    return bound as T;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.current = ROOT_CONTEXT;
    return this;
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
  context.setGlobalContextManager(new SequentialContextManager());
  return {
    spans: () =>
      exporter.getFinishedSpans().map((span) => ({
        name: span.name,
        attributes: { ...span.attributes },
      })),
    dispose: async () => {
      trace.disable();
      context.disable();
      await provider.shutdown();
    },
  };
}
