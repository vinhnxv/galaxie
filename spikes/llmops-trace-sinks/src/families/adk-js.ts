// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Adapted from tests/conformance/support/adk.ts and adapter-adk/test/support/adk-env.ts:
// built package imports, an injected tracer provider, and distinct content scan markers.
// This measures the capability fixture; conformance goldens remain outside this lane.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AdkAgent } from '@galaxie-ai/adapter-adk';
import { createRuntime, defineAgentDefinition } from '@galaxie-ai/core';
import { MockChatModel } from '@galaxie-ai/models/mock';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { z } from 'zod';
import { type CoverageProvider, createProvider } from './provider.js';

z.config({ jitless: true });
process.env['ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS'] = 'false';
// Load the built shim before the public entry, whose re-exports also evaluate ADK.
const { ensureAdkRuntimeEnv } = (await import(
  new URL('./runtime-shim.js', import.meta.resolve('@galaxie-ai/adapter-adk')).href
)) as { ensureAdkRuntimeEnv(): void };
ensureAdkRuntimeEnv();

export const adkMarkers = [
  'llmops-adk-prompt-marker',
  'llmops-adk-reply-marker',
  'llmops-adk-argument-marker',
  'llmops-adk-result-marker',
] as const;

export interface AdkCoverageRun {
  spans: readonly ReadableSpan[];
  modelCalls: number;
  capabilityCalls: number;
  outputCorrect: true;
}

export async function runAdk(own: CoverageProvider, capture: boolean): Promise<AdkCoverageRun> {
  // The provider must be global before ADK resolves its module-level proxy tracer.
  const { LlmAgent } = await import('@google/adk');
  const { createAdkAdapter } = await import('@galaxie-ai/adapter-adk');
  process.env['ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS'] = String(capture);
  const spec = JSON.parse(
    readFileSync(
      new URL('../../../../tests/conformance/cases-adk/fixtures.json', import.meta.url),
      'utf8',
    ),
  ).capability as {
    prompt: string;
    replies: {
      text: string;
      toolCalls?: { id: string; name: string; args: { value: number; note?: string } }[];
    }[];
  };
  const prompt = `${spec.prompt}: ${adkMarkers[0]}`;
  const expected = `${spec.replies[1]?.text} ${adkMarkers[1]}`;
  const replies = spec.replies.map((reply, index) => ({
    ...reply,
    id: `reply-${index}`,
    ...(reply.text ? { text: `${reply.text} ${adkMarkers[1]}` } : {}),
    ...(reply.toolCalls
      ? {
          toolCalls: reply.toolCalls.map((call) => ({
            ...call,
            args: { ...call.args, note: adkMarkers[2] },
          })),
        }
      : {}),
    usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
  }));
  const model = new MockChatModel({ [prompt]: replies });
  const host = createProvider({ live: !capture });
  const runtime = createRuntime({
    appId: 'llmops-adk-coverage',
    executors: [createAdkAdapter()],
    tracerProvider: host.provider,
  });
  const parameters = z.object({ value: z.number().int(), note: z.string().optional() });
  let capabilityCalls = 0;
  let output: unknown;
  try {
    const agent: AdkAgent = (context) =>
      new LlmAgent({
        name: 'agent',
        model: context.adk.llm('answer'),
        instruction: 'Use the supplied tools and answer briefly.',
        tools: [
          context.adk.capabilityTool('math.double@1', {
            toolName: 'math_double_1',
            description: 'Double an integer.',
            parameters,
          }),
        ],
      });
    const instance = await runtime.create(
      defineAgentDefinition({
        id: 'spike/adk-span-coverage',
        version: '1.0.0',
        executor: 'adk-js',
        input: z.object({ prompt: z.string() }),
        models: { answer: { modality: 'text' } },
        capabilities: {
          required: {
            'math.double@1': {
              kind: 'read',
              input: parameters,
              output: z.object({ value: z.number().int(), note: z.string() }),
            },
          },
        },
      }),
      {
        principalScope: 'fixture',
        agent,
        services: { chatModels: { mock: model } },
        bindings: {
          'math.double@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 1,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(input: z.infer<typeof parameters>) {
              capabilityCalls++;
              return { value: input.value * 2, note: adkMarkers[3] };
            },
          },
        },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              features: ['tool-calling'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      },
    );
    await instance.prepare();
    const { runId } = await instance.start({ prompt });
    for await (const event of instance.events(runId))
      if (event.type === 'output') output = event.output;
    assert.equal(instance.getSnapshot().run?.status, 'succeeded');
    assert.equal(output, expected, 'ADK output differs from scripted final reply');
    assert.equal(model.calls, 2, 'Script requires two model calls');
    assert.equal(capabilityCalls, 1, 'Script requires one capability call');
    await runtime.dispose();
    await host.flush();
    await own.flush();
    return {
      spans: host.oracle.getFinishedSpans(),
      modelCalls: model.calls,
      capabilityCalls,
      outputCorrect: true,
    };
  } finally {
    await runtime.dispose();
    await host.shutdown();
  }
}
