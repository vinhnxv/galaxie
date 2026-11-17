// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { afterEach, expect, test, vi } from 'vitest';
import { canary } from '../src/host.js';
import type { OtlpValue } from '../src/readback.js';
import { scenarioReadback } from '../src/scenario-readback.js';
import { errorText, prompt, reply, runScenario, type ScenarioResult } from '../src/scenarios.js';

vi.mock('../src/secrets.js', () => ({
  readEnv: () => ({ MLFLOW_PORT: '5100', MLFLOW_EXPERIMENT_ID: '1' }),
}));
afterEach(() => vi.unstubAllGlobals());

function encode(value: unknown): OtlpValue {
  if (Array.isArray(value)) return { array_value: { values: value.map(encode) } };
  if (typeof value === 'number') return { int_value: value };
  if (typeof value === 'boolean') return { bool_value: value };
  if (value !== null && typeof value === 'object')
    return {
      kvlist_value: {
        values: Object.entries(value).map(([key, item]) => ({ key, value: encode(item) })),
      },
    };
  return { string_value: String(value) };
}

function stubReadback(result: ScenarioResult, traceFields: Record<string, unknown> = {}): void {
  const observations = result.spans.map((span) => {
    const operation = span.attributes['gen_ai.operation.name'];
    return {
      id: span.spanContext().spanId,
      traceId: span.spanContext().traceId,
      parentObservationId: span.parentSpanContext?.spanId ?? null,
      name: span.name,
      metadata: Object.fromEntries(
        Object.entries(span.attributes).map(([key, value]) => [`attributes.${key}`, value]),
      ),
      type: operation === 'invoke_agent' ? 'AGENT' : operation === 'chat' ? 'GENERATION' : 'SPAN',
      model: operation === 'chat' ? 'fixture-1' : null,
      usageDetails: operation === 'chat' ? { input: 2, output: 3, total: 5 } : {},
    };
  });
  const spans = result.spans.map((span) => {
    const operation = span.attributes['gen_ai.operation.name'];
    const attributes: Record<string, unknown> = { ...span.attributes };
    if (operation === 'invoke_agent') attributes['mlflow.spanType'] = 'AGENT';
    if (operation === 'chat') {
      attributes['mlflow.spanType'] = 'CHAT_MODEL';
      attributes['mlflow.llm.model'] = 'fixture-1';
      attributes['mlflow.chat.tokenUsage'] = { input_tokens: 2, output_tokens: 3, total_tokens: 5 };
    }
    return {
      trace_id: Buffer.from(span.spanContext().traceId, 'hex').toString('base64'),
      span_id: Buffer.from(span.spanContext().spanId, 'hex').toString('base64'),
      ...(span.parentSpanContext
        ? { parent_span_id: Buffer.from(span.parentSpanContext.spanId, 'hex').toString('base64') }
        : {}),
      name: span.name,
      attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: encode(value) })),
    };
  });
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/observations?')) return Response.json({ data: observations, meta: {} });
    if (url.includes('/api/public/traces/'))
      return Response.json({ id: result.traceIds[0], ...traceFields });
    if (url.includes('/traces/search'))
      return Response.json({ traces: [{ trace_id: `tr-${result.traceIds[0]}` }] });
    return Response.json({ trace: { spans } });
  });
}

test('missing MLflow status uses the OTLP unset vocabulary', async () => {
  const result = await runScenario('linear', { text: false, live: false });
  stubReadback(result);
  expect(await scenarioReadback(result)).toMatchObject({
    backends: {
      mlflow: [
        { status: 'STATUS_CODE_UNSET' },
        { status: 'STATUS_CODE_UNSET' },
        { status: 'STATUS_CODE_UNSET' },
      ],
    },
  });
});

test.each([canary, errorText, prompt, reply, 'synthetic public input'])(
  'default readback rejects trace-level content marker %s',
  async (marker) => {
    const result = await runScenario('linear', { text: false, live: false });
    stubReadback(result, { input: marker });
    await expect(scenarioReadback(result)).rejects.toThrow(
      marker === canary
        ? 'Credential canary appeared'
        : marker === errorText
          ? 'Model error message appeared'
          : 'Default trace included text',
    );
  },
);
