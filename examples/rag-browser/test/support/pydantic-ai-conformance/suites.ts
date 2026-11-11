// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createPyodideAdapter, type PyodideAdapterOptions } from '@galaxie-ai/adapter-pyodide';
import { IndexedDBSaver } from '@galaxie-ai/storage-indexeddb';
import {
  type ChildApprovalCase,
  type ChildApprovalLifetime,
  childApprovalCases,
  runChildApprovalLifetime,
} from '../../../../../tests/conformance/support/pydantic-ai-child-approval-conformance.js';
import {
  type DelegationCase,
  type DelegationLifetime,
  delegationCases,
  runDelegationLifetime,
} from '../../../../../tests/conformance/support/pydantic-ai-delegation-conformance.js';

export interface SuiteObservations {
  readonly bridge: { op: string; role?: string; effectScope?: string }[];
  readonly workers: { created: number; terminated: number };
}

export interface SuiteResult extends SuiteObservations {
  readonly suite: 'delegation' | 'child-approval';
  readonly case: DelegationCase | ChildApprovalCase;
  readonly lifetime: DelegationLifetime | ChildApprovalLifetime;
  readonly effects: number;
  readonly subgraphs: boolean;
}

/** Run exactly one Worker lifetime; the next step starts after a real page reload. */
export async function runSuiteStep(
  options: PyodideAdapterOptions,
  parameters: URLSearchParams,
  observations: SuiteObservations,
): Promise<SuiteResult> {
  const suite = parameters.get('suite');
  const name = parameters.get('case') ?? '';
  if (
    !(
      (suite === 'delegation' && (delegationCases as readonly string[]).includes(name)) ||
      (suite === 'child-approval' && (childApprovalCases as readonly string[]).includes(name))
    )
  )
    throw new Error('The conformance suite or case is unknown.');
  const agent = {
    baseUrl: new URL(`/conformance/${name}/`, location.href).href,
    module: 'selected',
    entry: suite === 'delegation' ? 'create_agent' : name.replaceAll('-', '_'),
    files: [
      suite === 'delegation' ? 'delegation_suite.py' : 'child_approval_suite.py',
      'selected.py',
    ],
  };
  const saved = sessionStorage.getItem('pydanticSuiteStep');
  const step: { sessionId?: string } = saved ? JSON.parse(saved) : {};
  const saver = await IndexedDBSaver.open({
    databaseName: 'pydantic-suite-reload',
    appId: 'pydantic-suite',
    principalScope: 'fixture',
  });
  try {
    const store = {
      checkpoints: { request: (value: unknown) => saver.byteRecords.request(value) },
      recovery: saver.recovery,
    };
    const lifetime =
      suite === 'delegation'
        ? await runDelegationLifetime(options, agent, store, name as DelegationCase, step.sessionId)
        : await runChildApprovalLifetime(
            createPyodideAdapter({ ...options, framework: 'pydantic-ai' }),
            agent,
            store,
            name as ChildApprovalCase,
            step.sessionId,
          );
    const exported = await saver.exportSession(lifetime.sessionId);
    return {
      suite,
      case: name as DelegationCase | ChildApprovalCase,
      lifetime,
      ...observations,
      effects: exported.metadata.recovery.effects.count,
      subgraphs: lifetime.subgraphs,
    };
  } finally {
    saver.close();
  }
}
