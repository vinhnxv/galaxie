// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { SpanStatusCode } from '@opentelemetry/api';
import { afterEach, expect, test, vi } from 'vitest';
import { assertSpanTree, serializeSpans } from '../../../packages/core/test/span-tree.js';
import { canary, collectorUrl } from '../src/host.js';
import { observationsQuery, readBack } from '../src/readback.js';
import { errorText, prompt, reply, runScenario, scenarios } from '../src/scenarios.js';

vi.mock('../src/secrets.js', () => ({
  readEnv: () => ({ MLFLOW_PORT: '5100', MLFLOW_EXPERIMENT_ID: '1' }),
}));
afterEach(() => vi.unstubAllGlobals());

test.each([
  'observation page',
  'later observation page',
  'Langfuse trace',
  'MLflow search',
  'MLflow detail',
  'run query page',
])('inspection rejects a canary in the complete %s envelope', async (target) => {
  let pages = 0;
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/api/public/traces/'))
      return Response.json({
        id: 'fixture-trace',
        input: target === 'Langfuse trace' ? canary : null,
      });
    if (url.includes('/observations?')) {
      pages++;
      return Response.json({
        data: [],
        meta: target === 'later observation page' && pages === 1 ? { cursor: 'next' } : {},
        ...(target === 'observation page' ||
        target === 'run query page' ||
        (target === 'later observation page' && pages === 2)
          ? { inspectionProbe: canary }
          : {}),
      });
    }
    if (url.includes('/traces/search'))
      return Response.json({
        traces: [{ trace_id: 'tr-fixture' }],
        ...(target === 'MLflow search' ? { inspectionProbe: canary } : {}),
      });
    return Response.json({
      trace: { spans: [] },
      ...(target === 'MLflow detail' ? { inspectionProbe: canary } : {}),
    });
  });
  const inspect = (body: unknown): void => {
    if (JSON.stringify(body).includes(canary))
      throw new Error('Envelope inspection detected the credential canary');
  };
  const read =
    target === 'run query page'
      ? observationsQuery({ filter: 'fixture-run-filter' }, inspect)
      : readBack('fixture-trace', inspect);
  await expect(read).rejects.toThrow('Envelope inspection detected the credential canary');
});

test('collector destination is the local OTLP HTTP traces endpoint', () => {
  expect(collectorUrl).toBe('http://127.0.0.1:4318/v1/traces');
});

test.each(scenarios)('%s has the expected offline oracle in both text modes', async (name) => {
  for (const text of [false, true]) {
    const result = await runScenario(name, { text, live: false });
    expect(result.credentialCalls).toBeGreaterThan(0);
    expect(serializeSpans(result.spans)).not.toContain(canary);
    expect(serializeSpans(result.spans)).not.toContain(errorText);
    expect(result.traceIds).toHaveLength(name === 'interrupt-resume' ? 2 : 1);
    const roots = result.spans.filter((span) => span.name.startsWith('invoke_agent'));
    expect(roots.map((span) => span.attributes['galaxie.run.segment']).sort()).toEqual(
      name === 'interrupt-resume' ? [0, 1] : [0],
    );
    expect(new Set(roots.map((span) => span.attributes['galaxie.run.id']))).toEqual(
      new Set([result.runId]),
    );
    for (const traceId of result.traceIds) {
      const tree = assertSpanTree(
        result.spans.filter((span) => span.spanContext().traceId === traceId),
        text ? { text: 'allowed' } : undefined,
      );
      expect(tree.name).toBe(`invoke_agent spike/${name}`);
    }
    const models = result.spans.filter((span) => span.name === 'chat fixture-1');
    expect(models).toHaveLength(name === 'interrupt-resume' ? 2 : 1);
    for (const model of models) {
      expect(model.attributes).toMatchObject({
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'galaxie-fixture',
        'gen_ai.request.model': 'fixture-1',
      });
      expect(model.attributes['gen_ai.input.messages'] !== undefined).toBe(text);
      expect(model.attributes['gen_ai.output.messages'] !== undefined).toBe(
        text && name !== 'model-failure',
      );
      if (text) {
        expect(JSON.parse(String(model.attributes['gen_ai.input.messages']))).toEqual([
          { role: 'user', parts: [{ type: 'text', content: 'Synthetic Node host prompt' }] },
        ]);
        if (name !== 'model-failure')
          expect(JSON.parse(String(model.attributes['gen_ai.output.messages']))).toEqual([
            {
              role: 'assistant',
              parts: [{ type: 'text', content: 'Synthetic Node host reply' }],
              finish_reason: 'stop',
            },
          ]);
      }
      if (name === 'model-failure') {
        expect(model.status.code).toBe(SpanStatusCode.ERROR);
        // The credential-routed path deliberately generalizes provider error types.
        expect(model.attributes['error.type']).toBe('Error');
      } else
        expect(model.attributes).toMatchObject({
          'gen_ai.usage.input_tokens': 2,
          'gen_ai.usage.output_tokens': 3,
        });
      expect(
        result.spans.find((span) => span.spanContext().spanId === model.parentSpanContext?.spanId)
          ?.name,
      ).toMatch(/^galaxie.node /);
    }
    for (const span of result.spans) {
      expect(span.attributes['galaxie.error.code']).toBe(
        name === 'model-failure' && roots.includes(span) ? 'executor_error' : undefined,
      );
      if (!text)
        for (const key of [
          'gen_ai.input.messages',
          'gen_ai.output.messages',
          'gen_ai.tool.call.arguments',
        ])
          expect(span.attributes[key]).toBeUndefined();
    }
    if (!text)
      for (const marker of [prompt, reply])
        expect(serializeSpans(result.spans)).not.toContain(marker);
    if (name === 'tool-call') {
      const tool = result.spans.find((span) => span.name === 'execute_tool lookup@1');
      expect(tool).toBeDefined();
      expect(
        result.spans.find((span) => span.spanContext().spanId === tool?.parentSpanContext?.spanId)
          ?.name,
      ).toBe('galaxie.node lookup');
      expect(tool?.attributes['gen_ai.tool.call.arguments']).toBe(
        text ? JSON.stringify({ query: 'synthetic lookup argument' }) : undefined,
      );
    }
  }
});
