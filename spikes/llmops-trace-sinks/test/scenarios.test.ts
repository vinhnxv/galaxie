// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { SpanStatusCode } from '@opentelemetry/api';
import { expect, test } from 'vitest';
import { assertSpanTree, serializeSpans } from '../../../packages/core/test/span-tree.js';
import { canary } from '../src/node-host.js';
import { errorText, prompt, reply, runScenario, scenarios } from '../src/scenarios.js';

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
