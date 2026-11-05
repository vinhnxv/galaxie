// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { expect } from 'vitest';
import { LEGAL_DISCLAIMER } from '../../src/host/disclaimer.js';
import { type FinancialResult, type FinancialScenario, INJECTION } from './financial.js';

export function assertFinancialState(result: FinancialResult): void {
  expect(result.status).toBe('succeeded');
  expect(Object.keys(result.state)).toEqual([
    'market_data_analysis_output',
    'proposed_trading_strategies_output',
    'execution_plan_output',
    'final_risk_assessment_output',
  ]);
  expect(result.requests.map((request) => request.role)).toEqual([
    'financial.data',
    'financial.data',
    'financial.trading',
    'financial.execution',
    'financial.risk',
  ]);
  expect(result.requests[2]?.instruction).toContain(result.state['market_data_analysis_output']);
  expect(result.requests[3]?.instruction).toContain(
    result.state['proposed_trading_strategies_output'],
  );
  for (const key of [
    'market_data_analysis_output',
    'proposed_trading_strategies_output',
    'execution_plan_output',
  ])
    expect(result.requests[4]?.instruction).toContain(result.state[key]);
  expect(result.output).toBe(result.state['final_risk_assessment_output']);
  expect(String(result.output).endsWith(LEGAL_DISCLAIMER)).toBe(true);
  // The scripted replies include the disclaimer, so also prove the recipe's own instructions ask for it.
  expect(result.requests[0]?.instruction).not.toContain(LEGAL_DISCLAIMER);
  for (const request of result.requests.slice(2))
    expect(request.instruction).toContain(LEGAL_DISCLAIMER);
  for (const request of result.requests.slice(2))
    expect(request.contents).toContain('Risk attitude: conservative');
  expect(result.requests[1]?.contents).toContain('untrusted-tool-output');
  expect(result.requests[0]?.tools).toEqual(['market_search_1']);
  for (const request of result.requests.slice(2)) expect(request.tools).toEqual([]);
}

export function assertFinancialScenario(
  scenario: FinancialScenario,
  result: FinancialResult,
): void {
  const streams = result.events.filter((event) => event.type === 'stream');
  const messages: { author: string; text: string }[] = [];
  const updates: unknown[] = [];
  for (const event of streams) {
    expect(event.executor).toBe('adk-js');
    expect(event.path).toEqual([]);
    if (event.mode === 'messages') messages.push(event.data as { author: string; text: string });
    else if (event.mode === 'updates') updates.push(event.data);
  }
  expect(updates).toEqual([
    { step: 'tool_call', tool: 'market_search_1', index: 0 },
    { step: 'tool_result', tool: 'market_search_1', index: 1 },
  ]);
  if (scenario === 'budget' || scenario === 'blocked') {
    expect(result.status).toBe('failed');
    expect(result.error).toBe(scenario === 'budget' ? 'budget_exceeded' : 'denied');
    expect(result.output).toBeUndefined();
    expect(result.state).toEqual({});
    expect(JSON.stringify(result.events)).not.toContain('Risk assessment:');
    if (scenario === 'blocked') {
      expect(result.checked.some((text) => text.includes('Risk assessment:'))).toBe(true);
      expect(messages.some((message) => message.author === 'risk_analyst_agent')).toBe(true);
      expect(result.events.at(-1)?.type).toBe('error');
    }
    return;
  }
  assertFinancialState(result);
  const authors = [...new Set(messages.map((message) => message.author))];
  expect(authors).toEqual([
    'data_analyst_agent',
    'trading_analyst_agent',
    'execution_analyst_agent',
    'risk_analyst_agent',
  ]);
  expect(messages.map((message) => message.author)).toEqual(
    authors.flatMap((author) =>
      messages.filter((message) => message.author === author).map(() => author),
    ),
  );
  for (const [author, key] of [
    ['data_analyst_agent', 'market_data_analysis_output'],
    ['trading_analyst_agent', 'proposed_trading_strategies_output'],
    ['execution_analyst_agent', 'execution_plan_output'],
    ['risk_analyst_agent', 'final_risk_assessment_output'],
  ]) {
    const chunks = messages.filter((message) => message.author === author);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((message) => message.text).join('')).toBe(result.state[key ?? '']);
    let growing = '';
    for (const chunk of chunks) {
      growing += chunk.text;
      expect(result.checked).toContain(growing);
    }
  }
  const firstMessage = streams.findIndex((event) => event.mode === 'messages');
  expect(streams.slice(0, firstMessage).map((event) => event.mode)).toEqual(['updates', 'updates']);
  if (scenario === 'empty') {
    expect(result.searches).toEqual([{ query: 'Unknown Demo Company' }]);
    expect(result.requests[1]?.contents).toContain('"items":[]');
    expect(result.state['market_data_analysis_output']).toContain('empty findings');
    expect(result.requests[2]?.instruction).toContain('No fixture evidence');
  } else {
    expect(result.searches).toEqual([{ query: 'Lantern Orchard Workshop' }]);
    expect(result.requests[1]?.contents).toContain('bulletin-lantern');
  }
  if (scenario === 'injection') {
    expect(result.requests[1]?.contents).toContain(INJECTION);
    expect(JSON.stringify(result.events)).not.toContain(INJECTION);
  }
}
