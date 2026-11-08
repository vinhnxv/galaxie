// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { goBuild } from 'virtual:adk-recipes-go';
import { pythonBuild } from 'virtual:adk-recipes-python';
import type { AgentDefinition, ExecutorAdapter, ModelRouting } from '@galaxie-ai/core';
import type { MockChatModel } from '@galaxie-ai/models/mock';
import { financialDefinition } from '../recipes/financial/definition.js';
import { createFinancialMockModels, FINANCIAL_SAMPLE_PROMPT } from '../recipes/financial/script.js';
import { financialGoAgent, financialGoDefinition } from '../recipes/financial-go/definition.js';
import { auditorAgent, auditorDefinition } from '../recipes/llm-auditor/definition.js';
import { AUDITOR_SAMPLE_PROMPT, createAuditorMockModels } from '../recipes/llm-auditor/script.js';
import { loanAgent, loanDefinition } from '../recipes/loan/definition.js';
import { createLoanMockModels, LOAN_SAMPLE_PROMPT } from '../recipes/loan/script.js';

export type RecipeId = 'financial-js' | 'financial-go' | 'llm-auditor' | 'loan';
interface Recipe {
  readonly id: RecipeId;
  readonly label: string;
  readonly available: boolean;
  readonly definition: AgentDefinition;
  readonly prompt: string;
  readonly financial: boolean;
  models(): {
    readonly chatModels: Readonly<Record<string, MockChatModel>>;
    readonly routing: ModelRouting;
  };
  load(): Promise<{ executor: ExecutorAdapter<unknown, unknown>; agent: unknown }>;
}

async function pythonRecipe(loan: boolean): ReturnType<Recipe['load']> {
  const [{ createPyodideAdapter }, { createPyodideWorker }] = await Promise.all([
    import('@galaxie-ai/adapter-pyodide'),
    import('./trusted-types.js'),
  ]);
  return {
    executor: createPyodideAdapter({
      framework: 'adk',
      runtimeUrl: new URL('/python/runtime/', location.href).href,
      wheelsUrl: new URL('/python/wheels/', location.href).href,
      localWheels: pythonBuild.localWheels,
      createWorker: createPyodideWorker,
    }) as ExecutorAdapter<unknown, unknown>,
    agent: (loan ? loanAgent : auditorAgent)(new URL('/python/agent/', location.href).href),
  };
}

/** Imports and constructs only the executor selected for this document. */
export const recipes: readonly Recipe[] = [
  {
    id: 'financial-js',
    label: 'Financial advisor (JavaScript)',
    available: true,
    definition: financialDefinition,
    prompt: FINANCIAL_SAMPLE_PROMPT,
    financial: true,
    models: createFinancialMockModels,
    async load() {
      const [{ createAdkAdapter }, { financialAgent }] = await Promise.all([
        import('@galaxie-ai/adapter-adk'),
        import('../recipes/financial/agent.js'),
      ]);
      return {
        executor: createAdkAdapter() as ExecutorAdapter<unknown, unknown>,
        agent: financialAgent,
      };
    },
  },
  {
    id: 'financial-go',
    label: 'Financial advisor (Go)',
    available: goBuild.available,
    definition: financialGoDefinition,
    prompt: FINANCIAL_SAMPLE_PROMPT,
    financial: true,
    models: createFinancialMockModels,
    async load() {
      if (!goBuild.wasm) throw new Error('The Go recipe assets are unavailable.');
      const [{ createGoAdapter }, { createGoWorker }] = await Promise.all([
        import('@galaxie-ai/adapter-go'),
        import('./trusted-types.js'),
      ]);
      return {
        executor: createGoAdapter({ createWorker: createGoWorker }) as ExecutorAdapter<
          unknown,
          unknown
        >,
        agent: financialGoAgent({
          ...goBuild.wasm,
          url: new URL(goBuild.wasm.url, location.href).href,
        }),
      };
    },
  },
  {
    id: 'llm-auditor',
    label: 'LLM auditor (Python)',
    available: pythonBuild.available,
    definition: auditorDefinition,
    prompt: AUDITOR_SAMPLE_PROMPT,
    financial: false,
    models: createAuditorMockModels,
    load: () => pythonRecipe(false),
  },
  {
    id: 'loan',
    label: 'Small-business loan (Python)',
    available: pythonBuild.available,
    definition: loanDefinition,
    prompt: LOAN_SAMPLE_PROMPT,
    financial: false,
    models: createLoanMockModels,
    load: () => pythonRecipe(true),
  },
];

export function selectedRecipe(): Recipe {
  const id = new URL(location.href).searchParams.get('recipe');
  const found = recipes.find((recipe) => recipe.id === id) ?? recipes[0];
  if (!found) throw new Error('No recipe is registered.');
  return found;
}
