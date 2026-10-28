// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import type { RunTrace, TraceHandle } from '@galaxie/core';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';

interface ChainTrace {
  readonly handle: TraceHandle | undefined;
  readonly owned: boolean;
}

export class LangGraphTraceHandler extends BaseCallbackHandler {
  override name: string = 'galaxie-trace';
  override awaitHandlers: boolean = true;
  readonly #trace: RunTrace;
  readonly #chains: Map<string, ChainTrace> = new Map();
  readonly #models: Map<string, TraceHandle> = new Map();
  readonly #settlement: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  #root: string | undefined;

  constructor(trace: RunTrace) {
    super();
    this.#trace = trace;
  }

  async settled(): Promise<void> {
    if (this.#root !== undefined) await this.#settlement.promise;
  }

  override handleChainStart(
    _chain: unknown,
    _inputs: unknown,
    runId: string,
    parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ): void {
    // LangChain 1.2.20 invokes parentRunId fourth and runName eighth, unlike its declaration.
    // The first parentless chain is the graph run; later ones must not move the settlement barrier.
    if (parentRunId === undefined && this.#root === undefined) this.#root = runId;
    const parent = parentRunId === undefined ? undefined : this.#chains.get(parentRunId)?.handle;
    const owned =
      runName !== undefined &&
      runName === metadata?.['langgraph_node'] &&
      !tags?.includes('langsmith:hidden');
    const step = metadata?.['langgraph_step'];
    const handle = owned
      ? this.#trace.start(
          { kind: 'node', name: runName, ...(typeof step === 'number' ? { step } : {}) },
          parent,
        )
      : parent;
    this.#chains.set(runId, { handle, owned });
  }

  override handleChainEnd(_outputs: unknown, runId: string): void {
    const chain = this.#chains.get(runId);
    if (chain?.owned) chain.handle?.end({ status: 'ok' });
    this.#chains.delete(runId);
    if (runId === this.#root) this.#settlement.resolve();
  }

  override handleChainError(error: Error, runId: string): void {
    const chain = this.#chains.get(runId);
    if (chain?.owned) chain.handle?.end({ status: 'error', errorType: error.name });
    this.#chains.delete(runId);
    if (runId === this.#root) this.#settlement.resolve();
  }

  override handleChatModelStart(
    _llm: unknown,
    _messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    const provider = metadata?.['ls_provider'];
    const model = metadata?.['ls_model_name'];
    this.#models.set(
      runId,
      this.#trace.start(
        {
          kind: 'model',
          ...(typeof provider === 'string' ? { provider } : {}),
          ...(typeof model === 'string' ? { model } : {}),
        },
        parentRunId === undefined ? undefined : this.#chains.get(parentRunId)?.handle,
      ),
    );
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    const generation = output.generations[0]?.[0];
    const message =
      generation !== undefined && 'message' in generation ? generation.message : undefined;
    const usage =
      typeof message === 'object' && message !== null && 'usage_metadata' in message
        ? message.usage_metadata
        : undefined;
    const input =
      typeof usage === 'object' && usage !== null && 'input_tokens' in usage
        ? usage.input_tokens
        : undefined;
    const outputTokens =
      typeof usage === 'object' && usage !== null && 'output_tokens' in usage
        ? usage.output_tokens
        : undefined;
    this.#models.get(runId)?.end({
      status: 'ok',
      usage: {
        ...(typeof input === 'number' ? { inputTokens: input } : {}),
        ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
      },
    });
    this.#models.delete(runId);
  }

  override handleLLMError(error: Error, runId: string): void {
    this.#models.get(runId)?.end({ status: 'error', errorType: error.name });
    this.#models.delete(runId);
  }
}
