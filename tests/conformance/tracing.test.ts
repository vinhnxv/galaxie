// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';
import { createRuntime, type DiagnosticEvent, defineAgentDefinition } from '@galaxie/core';
import type { BaseChatModel, LangSmithParams } from '@langchain/core/language_models/chat_models';
import * as web from '@langchain/langgraph/web';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { collect } from '../../packages/core/test/fake-executor.js';
import { assertSpanTree, serializeSpans } from '../../packages/core/test/span-tree.js';
import { cases } from './cases/index.js';
import { assistantRoles, assistantRouting } from './support/routing.js';
import { FixtureModelError, ScriptedChatModel } from './support/scripted-chat-model.js';
import type { ConformanceCase } from './support/transcript.js';

const definition = defineAgentDefinition({
  id: 'conformance/graph',
  version: '1.0.0',
  executor: 'langgraph-js',
  input: z.unknown(),
  models: assistantRoles,
});

async function ready(
  fixture: ConformanceCase,
  model: BaseChatModel = new ScriptedChatModel(fixture.script),
  diagnostics?: (event: DiagnosticEvent) => void,
) {
  const exporter = new InMemorySpanExporter();
  const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
  const runtime = createRuntime({
    appId: 'conformance',
    executors: [createLangGraphAdapter()],
    tracerProvider: provider,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
  const instance = await runtime.create(definition, {
    principalScope: 'canary-principal',
    models: assistantRouting(),
    services: { chatModels: { assistant: model } },
    agent: (host) =>
      fixture.factory(web, host.langchain.chatModel('assistant'), host.langchain.checkpointer()),
  });
  await instance.prepare();
  return { runtime, instance, exporter, provider };
}

test('linear has one allowlisted run, node and model tree with provider and usage', async () => {
  const fixture = cases.linear;
  const { runtime, instance, exporter, provider } = await ready(fixture);
  try {
    const { runId } = await instance.start({ value: 2, private: 'canary-input' });
    const events = await collect(instance.events(runId));
    expect(events.at(-1)).toMatchObject({
      type: 'output',
      output: { value: 6, answer: 'linear response' },
    });
    await runtime.dispose();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(assertSpanTree(spans)).toEqual({
      name: 'invoke_agent conformance/graph',
      children: [
        { name: 'galaxie.node double', children: [] },
        { name: 'galaxie.node respond', children: [{ name: 'chat fixture-1', children: [] }] },
      ],
    });
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    expect(
      spans.find(({ name }) => name === 'invoke_agent conformance/graph')?.parentSpanContext,
    ).toBeUndefined();
    expect(spans.find(({ name }) => name === 'chat fixture-1')?.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'galaxie-fixture',
      'gen_ai.request.model': 'fixture-1',
      'gen_ai.usage.input_tokens': 2,
      'gen_ai.usage.output_tokens': 2,
      'galaxie.step.status': 'ok',
    });
    expect(serializeSpans(spans)).not.toMatch(
      /canary-input|canary-principal|linear request|linear response/,
    );
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

test('model failure ends the model, node and run with ERROR and exposes the raw canary only to diagnostics', async () => {
  const raw = new FixtureModelError('canary-error credentials=canary-credential');
  const model = new ScriptedChatModel({ 'failure request': { error: raw } });
  const diagnostics: DiagnosticEvent[] = [];
  const fixture = cases['model-failure'];
  const { runtime, instance, exporter, provider } = await ready(fixture, model, (event) => {
    diagnostics.push(event);
  });
  try {
    const { runId } = await instance.start(fixture.input);
    const events = await collect(instance.events(runId));
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: {
        code: 'executor_error',
        type: 'FixtureModelError',
        message: 'The executor or agent code failed.',
      },
    });
    expect(instance.getSnapshot().run?.status).toBe('failed');
    expect(diagnostics.find(({ kind }) => kind === 'run_failed')?.error).toBe(raw);
    await runtime.dispose();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(assertSpanTree(spans)).toEqual({
      name: 'invoke_agent conformance/graph',
      children: [
        { name: 'galaxie.node fail', children: [{ name: 'chat fixture-1', children: [] }] },
      ],
    });
    for (const span of spans) {
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.attributes['error.type']).toBe('FixtureModelError');
      expect(span.attributes['galaxie.error.code']).toBe(
        span.name === 'invoke_agent conformance/graph' ? 'executor_error' : undefined,
      );
    }
    expect(
      JSON.stringify({ snapshot: instance.getSnapshot(), events }) + serializeSpans(spans),
    ).not.toMatch(/canary-error|canary-credential|canary-principal|failure request/);
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

class CanaryModel extends ScriptedChatModel {
  override getLsParams(): LangSmithParams {
    return { ...super.getLsParams(), ls_model_name: 'canary-model-x\n' };
  }
}

test('a control character model name is replaced before entering spans', async () => {
  const fixture = cases.linear;
  const { runtime, instance, exporter, provider } = await ready(
    fixture,
    new CanaryModel(fixture.script),
  );
  try {
    const { runId } = await instance.start(fixture.input);
    expect((await collect(instance.events(runId))).at(-1)?.type).toBe('output');
    await runtime.dispose();
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    assertSpanTree(spans);
    expect(spans.find(({ name }) => name === 'chat _OTHER')?.attributes).toMatchObject({
      'gen_ai.request.model': '_OTHER',
    });
    expect(serializeSpans(spans)).not.toContain('canary-model-x');
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});

test('a model without forwarded config has a node span and no implicit model span', async () => {
  const fixture = cases['model-without-config'];
  const { runtime, instance, exporter, provider } = await ready(fixture);
  try {
    const { runId } = await instance.start(fixture.input);
    expect((await collect(instance.events(runId))).at(-1)?.type).toBe('output');
    await runtime.dispose();
    await provider.forceFlush();
    expect(assertSpanTree(exporter.getFinishedSpans())).toEqual({
      name: 'invoke_agent conformance/graph',
      children: [{ name: 'galaxie.node implicit', children: [] }],
    });
  } finally {
    await runtime.dispose();
    await provider.shutdown();
  }
});
