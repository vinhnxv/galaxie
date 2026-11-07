// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { type Results, resultsSchema } from './results.js';

export const MOCK_BANNER = 'MOCK — harness evidence only; never a model measurement.';
/** Report input is parsed again so every public entry point shares the export contract. */
export function report(input: Results): string {
  const results = resultsSchema.parse(input);
  const lines: string[] = [];
  if (results.armOrder.includes('mock')) lines.push(`> ${MOCK_BANNER}`, '');
  lines.push(
    '# Decision model demonstration',
    '',
    `Created: ${results.createdAt}`,
    '',
    `Browser: ${results.profile.browserVersion ?? 'unknown'}; cores: ${results.profile.hardwareConcurrency}; device memory GiB: ${results.profile.deviceMemoryGiB ?? 'not exposed'}.`,
    '',
    'These results are demonstrations under ADR-0016, never framework quality gates or recommendations by themselves.',
    '',
    '## Pinned inventory',
    '',
    '| Candidate | Revision | Weight license | Code license |',
    '| --- | --- | --- | --- |',
  );
  for (const entry of results.inventory)
    lines.push(
      `| ${entry.id} | ${entry.revision ?? 'managed; cannot pin'} | ${entry.license.weights ?? 'not established'} | ${entry.license.code ?? 'not stated'} |`,
    );
  for (const arm of results.arms) {
    lines.push(
      '',
      `## ${arm.id}`,
      '',
      `Evidence: ${arm.evidence}. Status: ${arm.status}; reason: ${arm.reason ?? 'none'}.`,
      '',
    );
    for (const [name, observation] of Object.entries(arm.functionalChecks))
      lines.push(`- ${name}: ${observation.status} (${observation.reason})`);
    lines.push(
      '',
      `Download ms: ${arm.download.status === 'measured' ? arm.download.value : `UNMEASURED (${arm.download.reason})`}.`,
      `Warm session creation ms: ${arm.loadWarm.status === 'measured' ? arm.loadWarm.value : `UNMEASURED (${arm.loadWarm.reason})`}.`,
    );
    if (arm.firstDecision.status === 'measured') {
      lines.push(
        '',
        '| State tokens | Questions / requests | End-to-end p50 / p95 ms | Tokenization p50 ms | Repeated-state extra tokens |',
        '| --- | --- | --- | --- | --- |',
      );
      for (const item of arm.firstDecision.value)
        lines.push(
          `| ${item.targetStateTokens} | ${item.questionCount} / ${item.runs[0]?.requests.map((request) => request.questionCount).join('+')} | ${item.summary.endToEndMs.p50} / ${item.summary.endToEndMs.p95 ?? item.summary.endToEndMs.p95Reason} | ${item.summary.tokenizationMs.p50} | ${item.runs[0]?.repeatedState.extraTokens ?? 'unknown'} |`,
        );
      lines.push(
        '',
        'One discarded warm-up per combination. Mock delays and token counts are synthetic harness evidence only.',
      );
    }
    if (arm.accuracy.status === 'measured')
      for (const split of arm.accuracy.value) {
        lines.push(
          '',
          `### ${split.split} accuracy`,
          '',
          '| Group | Correct / count | Accuracy | Wilson 95% |',
          '| --- | --- | --- | --- |',
        );
        for (const [name, value] of [
          ['overall', split.overall],
          ...split.byDomain.map((value) => [value.domain, value] as const),
          ...split.byType.map((value) => [value.type, value] as const),
        ] as const)
          lines.push(
            `| ${name} | ${value.correct}/${value.count} | ${value.fraction} | ${value.wilson95.low}–${value.wilson95.high} |`,
          );
      }
    if (arm.ece.status === 'measured')
      for (const split of arm.ece.value) {
        const calibration = split.calibration;
        lines.push(
          '',
          `${split.split} ECE: ${calibration.status === 'measured' ? calibration.value : 'not_applicable_no_confidence'}; missing confidence: ${calibration.missingConfidence}/${calibration.total}.`,
        );
        if (calibration.status === 'measured') {
          lines.push(
            '',
            '10 equal-width bins; minimum 10 answers per bin. All available confidences contribute; sparse bins are flagged.',
            '',
            '| Bin | Count | Mean confidence | Accuracy | Below minimum |',
            '| --- | --- | --- | --- | --- |',
          );
          for (const bin of calibration.bins)
            lines.push(
              `| ${bin.lower}–${bin.upper} | ${bin.count} | ${bin.meanConfidence ?? 'none'} | ${bin.accuracy ?? 'none'} | ${bin.belowMinimum} |`,
            );
        }
      }
    if (arm.agreement.status === 'measured')
      lines.push(
        '',
        `Reference agreement (separate from accuracy): ${arm.agreement.value.agreed}/${arm.agreement.value.count}, reference ${arm.agreement.value.referenceId} at ${arm.agreement.value.revision}.`,
      );
    if (arm.builtinAiBaseline.status === 'measured')
      lines.push(
        '',
        'Built-in AI baseline (zero-download comparison when already available):',
        '',
        '```json',
        JSON.stringify(arm.builtinAiBaseline.value, null, 2),
        '```',
      );
    lines.push(
      '',
      `Manual GPU memory MiB: alone ${arm.gpuMemory.modelAlone ?? 'UNMEASURED'}; with chat ${arm.gpuMemory.withChatModel ?? 'UNMEASURED'}; ${arm.gpuMemory.status}.`,
    );
  }
  lines.push('', '## UNMEASURED', '');
  function visit(value: unknown, path: string): void {
    if (value === null || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (
      [
        'not_measured',
        'not_run',
        'not_applicable_no_confidence',
        'unsupported_configuration',
      ].includes(String(object['status']))
    )
      lines.push(
        `- ${path}: ${String(object['reason'] ?? (object['source'] === 'manual' ? (object['status'] === 'unsupported_configuration' ? 'unsupported_configuration' : 'manual_reading_required') : object['status']))}`,
      );
    for (const [key, item] of Object.entries(object)) visit(item, `${path}.${key}`);
  }
  for (const arm of results.arms) {
    visit(arm, arm.id);
    if (arm.runtime === null) lines.push(`- ${arm.id}.runtime: ${arm.runtimeReason ?? 'not_run'}`);
    if (arm.gpuMemory.modelAlone === null)
      lines.push(`- ${arm.id}.gpuMemory.modelAlone: manual_reading_required`);
    if (arm.gpuMemory.withChatModel === null)
      lines.push(
        `- ${arm.id}.gpuMemory.withChatModel: ${arm.gpuMemory.status === 'unsupported_configuration' ? 'unsupported_configuration' : 'manual_reading_required'}`,
      );
  }
  lines.push(
    '- Dedicated-model inference and all resulting metrics: inference_not_implemented.',
    '- Laya tokenizer pins: device run must record missing digests and sizes.',
    '- WaterSheep browser packing: watersheep.js is absent at the pinned revision, contrary to the ADR table.',
    '- Host license review: outstanding; see ADR-0028.',
    '',
    'Mock output establishes no model accuracy, calibration, performance or GPU-memory result.',
    '',
  );
  return lines.join('\n');
}
