// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { canary } from './node-host.js';
import { normalize } from './normalize.js';
import { decodeValue, observationsQuery, waitForReadback } from './readback.js';
import { errorText, prompt, reply, type ScenarioResult } from './scenarios.js';

interface Finding {
  status: 'observed';
  backend: string;
  expectation: string;
  expected: unknown;
  actual: unknown;
}

interface StoredSpan {
  id: string;
  traceId: string;
  parentId: string | null;
  name: string;
  type: string | null;
  kind: string | number | null;
  status: string | number;
  attributes: Record<string, unknown>;
  model: string | null;
  usage: unknown;
  input: unknown;
  output: unknown;
  startTime: string | number;
  endTime: string | number;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// Span and trace counts come from the bead acceptance, not from observed backend output.
const expectedShape: Record<string, { spans: number; traces: number }> = {
  linear: { spans: 3, traces: 1 },
  'tool-call': { spans: 5, traces: 1 },
  'interrupt-resume': { spans: 8, traces: 2 },
  'model-failure': { spans: 3, traces: 1 },
};

// Differences the maintainer recorded as vendor representation, not galaxie defects. Anything
// else that differs from the in-memory oracle fails the run.
function isKnownFinding(finding: Finding): boolean {
  if (finding.expectation.endsWith(': gen_ai.tool.call.arguments')) return true;
  return (
    finding.backend === 'Langfuse' &&
    finding.expectation === 'emitted span name retained' &&
    typeof finding.expected === 'string' &&
    finding.expected.startsWith('execute_tool ')
  );
}

function orderSpansParentFirst(spans: readonly ReadableSpan[]): ReadableSpan[] {
  const visit = (parent: ReadableSpan): ReadableSpan[] => [
    parent,
    ...spans
      .filter((span) => span.parentSpanContext?.spanId === parent.spanContext().spanId)
      .sort(
        (a, b) =>
          compare(a.name, b.name) ||
          Number(a.attributes['galaxie.node.step'] ?? 0) -
            Number(b.attributes['galaxie.node.step'] ?? 0),
      )
      .flatMap(visit),
  ];
  return spans
    .filter((span) => !span.parentSpanContext)
    .sort(
      (a, b) =>
        Number(a.attributes['galaxie.run.segment']) - Number(b.attributes['galaxie.run.segment']),
    )
    .flatMap(visit);
}

function attributes(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) =>
        /^(galaxie\.|gen_ai\.|session\.id$|langfuse\.observation\.|error\.type$|mlflow\.(spanType|spanInputs|spanOutputs|chat\.tokenUsage|llm\.))/.test(
          key,
        ),
      )
      .sort(([a], [b]) => compare(a, b)),
  );
}

export async function scenarioReadback(result: ScenarioResult): Promise<unknown> {
  // This positive control must precede every backend read and every credential scan.
  assert.ok(result.credentialCalls > 0, 'getCredential was never called');
  const oracle = orderSpansParentFirst(result.spans);
  assert.equal(oracle.length, result.spans.length, 'Oracle ordering omitted spans');
  const shape = expectedShape[result.name];
  assert.ok(shape, `Unknown scenario ${result.name}`);
  assert.equal(oracle.length, shape.spans, 'Unexpected emitted span count');
  assert.equal(result.traceIds.length, shape.traces, 'Unexpected emitted trace count');
  const scan = (value: unknown): void => {
    const serialized = JSON.stringify(value);
    assert.ok(!serialized.includes(canary), 'Credential canary appeared in backend readback');
    assert.ok(!serialized.includes(errorText), 'Model error message appeared in backend readback');
    if (!result.text)
      for (const marker of [
        prompt,
        reply,
        'synthetic lookup argument',
        'synthetic capability result',
        'synthetic public input',
      ])
        assert.ok(!serialized.includes(marker), 'Default trace included text');
  };
  // Scan complete API responses before projection or filtering.
  const raw = [];
  for (const traceId of result.traceIds)
    raw.push(
      await waitForReadback(
        traceId,
        oracle
          .filter((span) => span.spanContext().traceId === traceId)
          .map((span) => span.spanContext().spanId),
        scan,
      ),
    );
  // Positive controls: the scan above only means something if the opted-in text is visible here.
  const rawText = JSON.stringify(raw);
  if (result.text) {
    assert.ok(rawText.includes(prompt), 'Opted-in prompt missing from backend readback');
    assert.equal(
      rawText.includes(reply),
      result.name !== 'model-failure',
      'Opted-in reply presence differs from the scenario',
    );
    if (result.name === 'tool-call')
      assert.ok(
        rawText.includes('synthetic lookup argument'),
        'Opted-in tool argument missing from backend readback',
      );
  }
  const findings: Finding[] = [];
  const measure = (
    backend: string,
    expectation: string,
    actual: unknown,
    expected: unknown,
  ): void => {
    try {
      assert.deepEqual(actual, expected);
    } catch (error) {
      if (!(error instanceof assert.AssertionError)) throw error;
      findings.push({ status: 'observed', backend, expectation, expected, actual });
    }
  };
  const langfuse = raw.flatMap((item) => item.observations);
  const mlflow = raw.flatMap((item) => item.spans);
  const oracleIds = oracle.map((span) => span.spanContext().spanId).sort(compare);
  assert.deepEqual(
    langfuse.map((span) => span.id).sort(compare),
    oracleIds,
    'Langfuse span set differs from the oracle',
  );
  assert.deepEqual(
    mlflow.map((span) => Buffer.from(span.span_id, 'base64').toString('hex')).sort(compare),
    oracleIds,
    'MLflow span set differs from the oracle',
  );
  const records: Record<string, StoredSpan[]> = { langfuse: [], mlflow: [] };
  for (const source of oracle) {
    const id = source.spanContext().spanId;
    const observation = langfuse.find((span) => span.id === id);
    const span = mlflow.find((span) => Buffer.from(span.span_id, 'base64').toString('hex') === id);
    assert.ok(observation, `Langfuse missing ${id}`);
    assert.ok(span, `MLflow missing ${id}`);
    assert.equal(observation.traceId, source.spanContext().traceId);
    assert.equal(
      Buffer.from(span.trace_id, 'base64').toString('hex'),
      source.spanContext().traceId,
    );
    assert.equal(observation.parentObservationId || null, source.parentSpanContext?.spanId ?? null);
    assert.equal(
      span.parent_span_id ? Buffer.from(span.parent_span_id, 'base64').toString('hex') : null,
      source.parentSpanContext?.spanId ?? null,
    );
    measure('Langfuse', 'emitted span name retained', observation.name, source.name);
    measure('MLflow', 'emitted span name retained', span.name, source.name);
    const lfAttributes = Object.fromEntries(
      Object.entries(observation.metadata)
        .filter(([key]) => key.startsWith('attributes.'))
        .map(([key, value]) => [key.slice('attributes.'.length), value]),
    );
    const mfAttributes = Object.fromEntries(
      span.attributes.map(({ key, value }) => [key, decodeValue(value)]),
    );
    records['langfuse']?.push({
      id,
      traceId: observation.traceId,
      parentId: observation.parentObservationId || null,
      name: observation.name,
      type: observation.type ?? null,
      kind: null,
      status: observation.level ?? '',
      attributes: attributes(lfAttributes),
      model: observation.model || null,
      usage: observation.usageDetails ?? {},
      input: observation.input ?? null,
      output: observation.output ?? null,
      startTime: observation.startTime,
      endTime: observation.endTime,
    });
    records['mlflow']?.push({
      id,
      traceId: source.spanContext().traceId,
      parentId: source.parentSpanContext?.spanId ?? null,
      name: span.name,
      type:
        typeof mfAttributes['mlflow.spanType'] === 'string'
          ? mfAttributes['mlflow.spanType']
          : null,
      kind: span.kind ?? null,
      status: span.status?.code ?? 'UNSET',
      attributes: attributes(mfAttributes),
      model:
        typeof mfAttributes['mlflow.llm.model'] === 'string'
          ? mfAttributes['mlflow.llm.model']
          : null,
      usage: mfAttributes['mlflow.chat.tokenUsage'] ?? {},
      input: mfAttributes['mlflow.spanInputs'] ?? null,
      output: mfAttributes['mlflow.spanOutputs'] ?? null,
      startTime: '<timestamp>',
      endTime: '<timestamp>',
    });
    const operation = source.attributes['gen_ai.operation.name'];
    if (operation === 'execute_tool') {
      measure(
        'Langfuse',
        'tool is named for the capability',
        observation.name.includes('lookup@1'),
        true,
      );
      measure('MLflow', 'tool is named for the capability', span.name.includes('lookup@1'), true);
    }
    for (const [backend, attrs] of [
      ['Langfuse', lfAttributes],
      ['MLflow', mfAttributes],
    ] as const) {
      // Every emitted attribute must survive; backends may move text into their I/O fields.
      for (const [key, expected] of Object.entries(source.attributes)) {
        if (key === 'gen_ai.input.messages' || key === 'gen_ai.output.messages') continue;
        measure(backend, `${source.name}: ${key}`, attrs[key] ?? null, expected);
      }
      if (result.name === 'model-failure')
        assert.equal(
          attrs['galaxie.error.code'],
          source.parentSpanContext ? undefined : 'executor_error',
        );
    }
    if (operation === 'invoke_agent' || operation === 'chat' || operation === 'execute_tool') {
      measure(
        'Langfuse',
        `${source.name}: observation type`,
        observation.type ?? null,
        operation === 'invoke_agent' ? 'AGENT' : operation === 'chat' ? 'GENERATION' : 'TOOL',
      );
      measure(
        'MLflow',
        `${source.name}: span type`,
        mfAttributes['mlflow.spanType'] ?? null,
        operation === 'invoke_agent' ? 'AGENT' : operation === 'chat' ? 'CHAT_MODEL' : 'TOOL',
      );
    }
    if (operation === 'chat') {
      measure(
        'Langfuse',
        'generation model',
        observation.model ?? null,
        source.attributes['gen_ai.request.model'],
      );
      measure(
        'MLflow',
        'chat model',
        mfAttributes['mlflow.llm.model'] ?? null,
        source.attributes['gen_ai.request.model'],
      );
      if (result.name !== 'model-failure') {
        measure('Langfuse', 'generation token usage', observation.usageDetails, {
          input: 2,
          output: 3,
          total: 5,
        });
        measure('MLflow', 'chat token usage', mfAttributes['mlflow.chat.tokenUsage'] ?? null, {
          input_tokens: 2,
          output_tokens: 3,
          total_tokens: 5,
        });
      }
      if (result.text)
        for (const [backend, input, output] of [
          ['Langfuse', observation.input, observation.output],
          ['MLflow', mfAttributes['mlflow.spanInputs'], mfAttributes['mlflow.spanOutputs']],
        ] as const) {
          measure(
            backend,
            'model input contains opted-in prompt',
            JSON.stringify(input ?? null).includes(prompt),
            true,
          );
          measure(
            backend,
            'model output contains opted-in reply',
            JSON.stringify(output ?? null).includes(reply),
            result.name !== 'model-failure',
          );
        }
    }
    if (source.status.code === SpanStatusCode.ERROR) {
      measure('Langfuse', `${source.name}: error level`, observation.level, 'ERROR');
      measure(
        'MLflow',
        `${source.name}: error status`,
        span.status?.code ?? null,
        'STATUS_CODE_ERROR',
      );
      assert.ok(!span.status?.message, 'Backend added an error status message');
    }
  }
  let runQuery: { mode: string; filter: unknown; traceIds: string[]; segments: number[] } | null =
    null;
  if (result.name === 'interrupt-resume') {
    const filter = JSON.stringify([
      {
        type: 'stringObject',
        column: 'metadata',
        key: 'galaxie.run.id',
        operator: '=',
        value: result.runId,
      },
    ]);
    const matches = await observationsQuery({ filter }, scan);
    const matchingRoots = matches.filter(
      (span) => span.metadata['galaxie.run.id'] === result.runId,
    );
    assert.equal(
      matches.length,
      matchingRoots.length,
      'Run-ID metadata filter returned observations of another run',
    );
    assert.deepEqual(
      new Set(matchingRoots.map((span) => span.traceId)),
      new Set(result.traceIds),
      'Run-ID query did not find both segments',
    );
    runQuery = {
      mode: 'server metadata filter',
      filter: JSON.parse(filter),
      traceIds: matchingRoots
        .map((span) => span.traceId)
        .sort((a, b) => result.traceIds.indexOf(a) - result.traceIds.indexOf(b)),
      segments: matchingRoots
        .map((span) => Number(span.metadata['attributes.galaxie.run.segment']))
        .sort((a, b) => a - b),
    };
    assert.deepEqual(runQuery.segments, [0, 1], 'Run-ID query did not return both segments');
  }
  const unexpected = findings.filter((finding) => !isKnownFinding(finding));
  assert.deepEqual(
    unexpected,
    [],
    'Backend output differs from the oracle beyond recorded findings',
  );
  return normalize(
    {
      scenario: result.name,
      developmentTraceText: result.text,
      credentialCalls: result.credentialCalls,
      credentialCanaryAbsent: true,
      defaultTextAbsent: !result.text,
      errorMessageAbsent: true,
      emittedSpanCount: oracle.length,
      backends: records,
      rootText: Object.fromEntries(
        Object.entries(records).map(([backend, spans]) => [
          backend,
          spans
            .filter((span) => span.parentId === null)
            .map((span) => ({
              inputPresent: span.input !== null,
              outputPresent: span.output !== null,
            })),
        ]),
      ),
      runQuery,
      findings,
    },
    oracle,
  );
}
