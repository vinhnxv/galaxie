// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'vitest';
import { createAdkAdapter } from '../../packages/adapter-adk/src/index.js';
import matrix from './compatibility-matrix-adk.json' with { type: 'json' };
import abort from './golden-adk/abort.json' with { type: 'json' };
import approvalApprove from './golden-adk/approval-approve.json' with { type: 'json' };
import approvalDeny from './golden-adk/approval-deny.json' with { type: 'json' };
import argumentBlock from './golden-adk/argument-block.json' with { type: 'json' };
import capability from './golden-adk/capability.json' with { type: 'json' };
import capabilityDenial from './golden-adk/capability-denial.json' with { type: 'json' };
import modelString from './golden-adk/model-string.json' with { type: 'json' };
import outputSchema from './golden-adk/output-schema.json' with { type: 'json' };
import plainText from './golden-adk/plain-text.json' with { type: 'json' };
import sequentialTools from './golden-adk/sequential-tools.json' with { type: 'json' };
import stepBudget from './golden-adk/step-budget.json' with { type: 'json' };
import streamingText from './golden-adk/streaming-text.json' with { type: 'json' };
import streamingTool from './golden-adk/streaming-tool.json' with { type: 'json' };
import toolsetFixed from './golden-adk/toolset-fixed.json' with { type: 'json' };
import { type AdkCase, adkCases, runAdkGalaxie } from './support/adk.js';

const goldens: Record<AdkCase, unknown> = {
  'plain-text': plainText,
  capability,
  'sequential-tools': sequentialTools,
  'output-schema': outputSchema,
  'capability-denial': capabilityDenial,
  'argument-block': argumentBlock,
  'step-budget': stepBudget,
  abort,
  'streaming-text': streamingText,
  'streaming-tool': streamingTool,
  'approval-approve': approvalApprove,
  'approval-deny': approvalDeny,
  'model-string': modelString,
  'toolset-fixed': toolsetFixed,
};

test.each(adkCases)('galaxie matches the native ADK golden: %s', async (name) => {
  expect(await runAdkGalaxie(name)).toEqual(goldens[name]);
});

test('the ADK compatibility matrix lists every case and the adapter features', () => {
  expect([...matrix.cases].sort()).toEqual([...adkCases].sort());
  expect(matrix.differences).toEqual([]);
  expect(matrix.features).toEqual(createAdkAdapter().features);
});
