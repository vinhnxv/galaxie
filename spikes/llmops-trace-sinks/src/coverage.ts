// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';

export const coverageRowIds = [
  'langgraph-js',
  'adk-js',
  'adk-js-own-spans',
  'pyodide-langgraph-python',
  'adk-go',
] as const;
export type RowId = (typeof coverageRowIds)[number];
export const spanKinds = ['root', 'node', 'model', 'capability', 'other'] as const;
export type SpanKind = (typeof spanKinds)[number];
const memoryOnly = 'not measured: maintainer decision' as const;
const noModels = 'not applicable: no model spans' as const;
const undetermined =
  'not determinable: span attributes are empty without a context manager' as const;
type NoUsage = typeof noModels | typeof undetermined;
const expectedExecutors: Partial<Record<RowId, string>> = {
  'langgraph-js': 'langgraph-js',
  'adk-js': 'adk-js',
  'pyodide-langgraph-python': 'langgraph-python',
  'adk-go': 'adk-go',
};

export interface CoverageSpan {
  name: string;
  attributes: Record<string, unknown>;
  parentSpanContext?: { spanId: string };
  spanContext(): { spanId: string; traceId: string };
}

export interface StoredSpan {
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

export interface Usage {
  name: string;
  present: boolean;
  input: number | null;
  output: number | null;
  total: number | null;
}

interface StoredCoverage {
  count: number;
  names: string[];
  types: (string | null)[];
}

interface KindCoverage {
  emitted: { count: number; names: string[] };
  langfuse: StoredCoverage | typeof memoryOnly;
  mlflow: StoredCoverage | typeof memoryOnly;
}

interface RowDescription {
  id: RowId;
  fixture: string[];
  scriptedCalls: { model: number; capability: number };
}

export interface MeasuredRow extends RowDescription {
  measurement: 'measured';
  lane: 'live' | 'in-memory';
  executorId: string | null;
  spans: Record<SpanKind, KindCoverage>;
  usage:
    | {
        emitted: Usage[];
        langfuse: Usage[] | typeof memoryOnly;
        mlflow: Usage[] | typeof memoryOnly;
      }
    | NoUsage;
  tree: { name: string; kind: SpanKind; parentName: string | null }[];
  controls?: Record<string, string | number | boolean>;
  versions?: Record<string, string>;
}

export interface UnmeasuredRow extends RowDescription {
  measurement: 'unmeasured';
  reason: string;
  probes: string[];
}

export type CoverageRow = MeasuredRow | UnmeasuredRow;
export interface Gap {
  name: string;
  disposition: 'follow-up';
  finding: string;
  evidence: { file: 'coverage-matrix.json'; path: string }[];
  proposedFix: string;
  beadsIssue: string;
}

export interface CoverageMatrix {
  scenario: unknown;
  rows: Record<RowId, CoverageRow>;
  gaps: Gap[];
  notMeasured: string[];
}

export function kindOf(span: Pick<CoverageSpan, 'attributes'>): SpanKind {
  const operation = span.attributes['gen_ai.operation.name'];
  if (operation === 'invoke_agent') return 'root';
  if (span.attributes['galaxie.node.name'] !== undefined) return 'node';
  if (operation === 'chat') return 'model';
  if (operation === 'execute_tool') return 'capability';
  return 'other';
}

function usage(name: string, input: unknown, output: unknown, total?: unknown): Usage {
  const inputValue = typeof input === 'number' ? input : null;
  const outputValue = typeof output === 'number' ? output : null;
  return {
    name,
    present: inputValue !== null && outputValue !== null,
    input: inputValue,
    output: outputValue,
    total:
      typeof total === 'number'
        ? total
        : inputValue !== null && outputValue !== null
          ? inputValue + outputValue
          : null,
  };
}

function storedUsage(span: StoredSpan): Usage {
  let value = span.usage;
  if (typeof value === 'string') value = JSON.parse(value);
  const data =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return usage(
    span.name,
    data['input'] ?? data['input_tokens'],
    data['output'] ?? data['output_tokens'],
    data['total'] ?? data['total_tokens'],
  );
}

export function buildRow(
  options: RowDescription & {
    spans: readonly CoverageSpan[];
    backends?: { langfuse: StoredSpan[]; mlflow: StoredSpan[] };
    controls?: Record<string, string | number | boolean>;
    versions?: Record<string, string>;
  },
): MeasuredRow {
  const { spans, backends } = options;
  const sourceById = new Map(spans.map((span) => [span.spanContext().spanId, span]));
  assert.equal(sourceById.size, spans.length, 'Oracle contains duplicate span IDs');
  const models = spans.filter((span) => kindOf(span) === 'model');
  const stored = (kind: SpanKind, backend: 'langfuse' | 'mlflow'): StoredSpan[] => {
    const selected = spans.filter((span) => kindOf(span) === kind);
    return selected
      .map((source) => {
        const found = backends?.[backend].find((span) => span.id === source.spanContext().spanId);
        assert.ok(found, `${backend} missing oracle span ${source.spanContext().spanId}`);
        return found;
      })
      .sort((a, b) => a.name.localeCompare(b.name) || String(a.type).localeCompare(String(b.type)));
  };
  const projection = (
    kind: SpanKind,
    backend: 'langfuse' | 'mlflow',
  ): StoredCoverage | typeof memoryOnly => {
    if (!backends) return memoryOnly;
    const rows = stored(kind, backend);
    return {
      count: rows.length,
      names: rows.map((span) => span.name),
      types: rows.map((span) => span.type),
    };
  };
  const root = spans.find((span) => kindOf(span) === 'root');
  const executor = root?.attributes['galaxie.executor.id'];
  return {
    id: options.id,
    measurement: 'measured',
    lane: backends ? 'live' : 'in-memory',
    fixture: options.fixture,
    scriptedCalls: options.scriptedCalls,
    executorId: typeof executor === 'string' ? executor : null,
    spans: Object.fromEntries(
      spanKinds.map((kind) => [
        kind,
        {
          emitted: {
            count: spans.filter((span) => kindOf(span) === kind).length,
            names: spans
              .filter((span) => kindOf(span) === kind)
              .map((span) => span.name)
              .sort(),
          },
          langfuse: projection(kind, 'langfuse'),
          mlflow: projection(kind, 'mlflow'),
        },
      ]),
    ) as Record<SpanKind, KindCoverage>,
    usage: models.length
      ? {
          emitted: models
            .map((span) =>
              usage(
                span.name,
                span.attributes['gen_ai.usage.input_tokens'],
                span.attributes['gen_ai.usage.output_tokens'],
              ),
            )
            .sort((a, b) => a.name.localeCompare(b.name)),
          langfuse: backends ? stored('model', 'langfuse').map(storedUsage) : memoryOnly,
          mlflow: backends ? stored('model', 'mlflow').map(storedUsage) : memoryOnly,
        }
      : options.id === 'adk-js-own-spans'
        ? undetermined
        : noModels,
    tree: spans
      .map((span) => ({
        name: span.name,
        kind: kindOf(span),
        parentName: span.parentSpanContext
          ? (sourceById.get(span.parentSpanContext.spanId)?.name ?? 'external parent')
          : null,
      }))
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) || String(a.parentName).localeCompare(String(b.parentName)),
      ),
    ...(options.controls ? { controls: options.controls } : {}),
    ...(options.versions ? { versions: options.versions } : {}),
  };
}

export function buildUnmeasuredRow(
  options: RowDescription & {
    reason: string;
    probes: string[];
  },
): UnmeasuredRow {
  return { ...options, measurement: 'unmeasured' };
}

export function deriveGaps(rows: Partial<Record<RowId, CoverageRow>>): Gap[] {
  const gaps: Gap[] = [];
  for (const id of coverageRowIds) {
    const row = rows[id];
    if (row?.measurement !== 'measured' || id === 'adk-js-own-spans') continue;
    const missing = (['node', 'model'] as const).filter(
      (kind) => row.spans[kind].emitted.count === 0,
    );
    if (missing.length)
      gaps.push({
        name: `${id}-span-coverage`,
        disposition: 'follow-up',
        finding: `${id} emits no ${missing.join(' and ')} spans in the measured scenario, despite the scripted model and capability calls completing.`,
        evidence: missing.map((kind) => ({
          file: 'coverage-matrix.json',
          path: `/rows/${id}/spans/${kind}`,
        })),
        proposedFix:
          'Emit node and model spans at the adapter boundary where the host brokers model calls and receives step notifications. Use the existing RunTrace contract and attribute allowlist, include usage from each host-side model response, and keep vendor mapping in the host collector.',
        beadsIssue: 'PENDING-CLAUDE',
      });
    if (typeof row.usage === 'object' && row.usage.emitted.some((value) => !value.present))
      gaps.push({
        name: `${id}-model-usage`,
        disposition: 'follow-up',
        finding: `${id} emits model spans without complete input and output token usage.`,
        evidence: [{ file: 'coverage-matrix.json', path: `/rows/${id}/usage/emitted` }],
        proposedFix:
          'Forward available host-side response token usage through the existing RunTrace model-span contract, independently of the executor framework. Keep vendor-specific mapping in the host collector.',
        beadsIssue: 'PENDING-CLAUDE',
      });
  }
  return gaps;
}

export function assertResultHygiene(serialized: string): void {
  assert.ok(!/\b[a-f0-9]{32}\b/i.test(serialized), 'Generated trace ID in result');
  assert.ok(
    !/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(serialized),
    'Generated UUID in result',
  );
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(serialized), 'Timestamp in result');
  assert.ok(
    !/\/(?:Users|home|private|tmp|var|opt|usr|root|etc)\//.test(serialized),
    'Machine-specific path in result',
  );
}

function auditUsage(values: Usage[], expectedCount: number): void {
  assert.ok(Array.isArray(values), 'Missing model usage');
  assert.equal(values.length, expectedCount, 'Model usage count differs from model spans');
  for (const value of values) {
    assert.equal(typeof value.name, 'string');
    for (const count of [value.input, value.output, value.total])
      assert.ok(
        count === null || (typeof count === 'number' && Number.isFinite(count) && count >= 0),
      );
    assert.equal(
      value.present,
      value.input !== null && value.output !== null,
      'Usage presence differs from values',
    );
  }
}

export function auditMatrix(matrix: CoverageMatrix, options: { requireIds?: boolean } = {}): void {
  assertResultHygiene(JSON.stringify(matrix));
  assert.ok(matrix.scenario, 'Missing scenario description');
  assert.ok(Array.isArray(matrix.notMeasured), 'Missing unmeasured list');
  assert.deepEqual(
    Object.keys(matrix.rows).sort(),
    [...coverageRowIds].sort(),
    'Incomplete coverage rows',
  );
  for (const id of coverageRowIds) {
    const row = matrix.rows[id];
    assert.equal(row.id, id, 'Row ID differs from its key');
    assert.ok(
      Array.isArray(row.fixture) && row.fixture.length > 0,
      `${id}: missing fixture provenance`,
    );
    for (const count of [row.scriptedCalls.model, row.scriptedCalls.capability])
      assert.ok(Number.isInteger(count) && count > 0, `${id}: missing scripted call count`);
    if (row.measurement === 'unmeasured') {
      assert.ok(
        typeof row.reason === 'string' && row.reason.trim().length > 0,
        `${id}: missing unmeasured reason`,
      );
      assert.ok(
        Array.isArray(row.probes) &&
          row.probes.length > 0 &&
          row.probes.every((probe) => typeof probe === 'string' && probe.trim()),
        `${id}: missing probes`,
      );
      continue;
    }
    assert.equal(row.measurement, 'measured', `${id}: unknown measurement`);
    const live = ['langgraph-js', 'adk-js', 'adk-js-own-spans'].includes(id);
    assert.equal(row.lane, live ? 'live' : 'in-memory', `${id}: incorrect measurement lane`);
    if (id === 'adk-js-own-spans') assert.equal(row.executorId, null, `${id}: unexpected executor`);
    else assert.equal(row.executorId, expectedExecutors[id], `${id}: unexpected root executor ID`);
    if (live) {
      assert.equal(row.controls?.['rawResponsesScanned'], true, `${id}: raw scan control failed`);
      assert.equal(
        row.controls?.['spanIdsAndParentsMatch'],
        true,
        `${id}: span and parent control failed`,
      );
    } else {
      assert.equal(row.controls?.['outputCorrect'], true, `${id}: output control failed`);
      assert.equal(
        row.controls?.['modelCalls'],
        row.scriptedCalls.model,
        `${id}: model calls differ from the script`,
      );
      assert.equal(
        row.controls?.['capabilityCalls'],
        row.scriptedCalls.capability,
        `${id}: capability calls differ from the script`,
      );
      if (id === 'adk-go')
        assert.equal(
          row.controls?.['goldenTranscriptMatched'],
          true,
          `${id}: golden transcript control failed`,
        );
    }
    let count = 0;
    for (const kind of spanKinds) {
      const entry: KindCoverage = row.spans[kind];
      assert.ok(entry, `${id}: missing ${kind} coverage`);
      assert.ok(Number.isInteger(entry.emitted.count) && entry.emitted.count >= 0);
      assert.ok(Array.isArray(entry.emitted.names));
      assert.equal(entry.emitted.names.length, entry.emitted.count);
      count += entry.emitted.count;
      for (const backend of ['langfuse', 'mlflow'] as const) {
        const measured = entry[backend];
        if (!live) assert.equal(measured, memoryOnly, `${id}: ${backend} must say ${memoryOnly}`);
        else {
          assert.ok(
            measured && typeof measured === 'object',
            `${id}: missing live ${backend} column`,
          );
          assert.equal(measured.count, entry.emitted.count, `${id}: ${backend} span count differs`);
          assert.equal(measured.names.length, measured.count);
          assert.equal(measured.types.length, measured.count);
          if (id !== 'adk-js-own-spans' && kind !== 'other') {
            const expectedNames =
              kind === 'capability' && backend === 'langfuse'
                ? entry.emitted.names.map((name) => name.replace(/^execute_tool /, ''))
                : entry.emitted.names;
            assert.deepEqual(
              [...measured.names].sort(),
              expectedNames,
              `${id}: ${backend} ${kind} names differ from emitted names`,
            );
            if (kind !== 'node')
              assert.ok(
                measured.types.every((type) => typeof type === 'string' && type.length > 0),
                `${id}: ${backend} ${kind} type missing`,
              );
          }
        }
      }
    }
    assert.ok(count > 0, `${id}: no emitted spans`);
    assert.equal(row.tree.length, count, `${id}: incomplete span tree`);
    if (id !== 'adk-js-own-spans')
      for (const entry of row.tree)
        assert.equal(
          entry.parentName === null,
          entry.kind === 'root',
          `${id}: ${entry.name} has an unexpected parent`,
        );
    if (row.spans.model.emitted.count === 0)
      assert.equal(row.usage, id === 'adk-js-own-spans' ? undetermined : noModels);
    else {
      assert.ok(typeof row.usage === 'object', `${id}: missing usage measurements`);
      auditUsage(row.usage.emitted, row.spans.model.emitted.count);
      for (const backend of ['langfuse', 'mlflow'] as const)
        if (live) {
          assert.ok(Array.isArray(row.usage[backend]), `${id}: missing ${backend} usage`);
          auditUsage(row.usage[backend] as Usage[], row.spans.model.emitted.count);
          assert.deepEqual(
            (row.usage[backend] as Usage[]).map(({ name: _name, ...counts }) => counts),
            row.usage.emitted.map(({ name: _name, ...counts }) => counts),
            `${id}: ${backend} usage differs from emitted usage`,
          );
        } else assert.equal(row.usage[backend], memoryOnly);
    }
  }
  const expected = deriveGaps(matrix.rows);
  assert.deepEqual(
    matrix.gaps.map((gap) => gap.name).sort(),
    expected.map((gap) => gap.name).sort(),
    'Gap set differs from measured evidence',
  );
  for (const gap of matrix.gaps) {
    assert.equal(gap.disposition, 'follow-up', `${gap.name}: unknown disposition`);
    assert.ok(
      typeof gap.finding === 'string' && gap.finding.length > 20,
      `${gap.name}: missing finding`,
    );
    assert.ok(
      typeof gap.proposedFix === 'string' && gap.proposedFix.length > 20,
      `${gap.name}: missing proposed fix`,
    );
    assert.match(
      gap.beadsIssue,
      options.requireIds ? /^galaxie-d53\.\d+$/ : /^(PENDING-CLAUDE|galaxie-d53\.\d+)$/,
      `${gap.name}: invalid issue ID ${gap.beadsIssue}`,
    );
    assert.deepEqual(
      gap.evidence,
      expected.find((value) => value.name === gap.name)?.evidence,
      `${gap.name}: evidence differs from gap`,
    );
  }
}
