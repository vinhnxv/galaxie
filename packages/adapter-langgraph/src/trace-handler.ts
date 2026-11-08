// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type {
  OutputSafetyOutcome,
  RunTrace,
  SelectedModelRoute,
  TraceHandle,
} from '@galaxie-ai/core';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import { isGraphInterrupt } from '@langchain/langgraph/web';
import { selectedRouteFromOptions } from './routed-chat-model.js';

function messagesText(
  messages: readonly BaseMessage[],
  finishReason?: string,
): readonly object[] | undefined {
  try {
    const result: object[] = [];
    for (const message of messages) {
      const content =
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      if (content === undefined) return undefined;
      const role =
        message.type === 'human' ? 'user' : message.type === 'ai' ? 'assistant' : message.type;
      result.push({
        role,
        parts: [{ type: 'text', content }],
        ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
      });
    }
    return result;
  } catch {
    return undefined;
  }
}

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
  readonly #routes = new Map<string, SelectedModelRoute>();
  readonly #outputSafety = new Map<string, OutputSafetyOutcome>();
  readonly #credentialFailures = new Set<unknown>();
  readonly #settlement: PromiseWithResolvers<void> = Promise.withResolvers<void>();
  #root: string | undefined;

  constructor(trace: RunTrace) {
    super();
    this.#trace = trace;
  }

  handleFor(runId: string): TraceHandle | undefined {
    return this.#chains.get(runId)?.handle;
  }

  /** Decisions share the node's trace parent and live run labels; record no request text. */
  startDecision(route: SelectedModelRoute, parentRunId?: string): TraceHandle {
    return this.#trace.start(
      { kind: 'model', route: { providerId: route.providerId, destination: route.destination } },
      parentRunId === undefined ? undefined : this.#chains.get(parentRunId)?.handle,
    );
  }

  setModelRoute(runId: string, selected: SelectedModelRoute): void {
    if (this.#models.has(runId))
      this.#routes.set(runId, {
        providerId: selected.providerId,
        destination: selected.destination,
      });
  }

  setOutputSafetyOutcome(runId: string, outcome: OutputSafetyOutcome | undefined): void {
    if (this.#models.has(runId) && outcome !== undefined) this.#outputSafety.set(runId, outcome);
  }

  /** Classify errors without changing the graph-facing object or storing the credential (ADR-0012). */
  recordCredentialFailure(error: unknown): void {
    this.#credentialFailures.add(error);
  }

  isCredentialFailure(error: unknown): boolean {
    const seen = new Set<unknown>();
    let current = error;
    while (!seen.has(current)) {
      if (this.#credentialFailures.has(current)) return true;
      if (typeof current !== 'object' || current === null || !('cause' in current)) return false;
      seen.add(current);
      current = current.cause;
    }
    return false;
  }

  async settled(): Promise<void> {
    if (this.#root !== undefined) await this.#settlement.promise;
    this.#credentialFailures.clear();
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
    if (chain?.owned)
      chain.handle?.end(
        // A pause unwinds the interrupting node and its parents; it is not a node failure.
        isGraphInterrupt(error)
          ? { status: 'ok' }
          : { status: 'error', errorType: this.isCredentialFailure(error) ? 'Error' : error.name },
      );
    this.#chains.delete(runId);
    if (runId === this.#root) this.#settlement.resolve();
  }

  override handleChatModelStart(
    _llm: unknown,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    const provider = metadata?.['ls_provider'];
    const model = metadata?.['ls_model_name'];
    const route = selectedRouteFromOptions(extraParams?.['options']);
    const input = this.#trace.recordsText ? messagesText(messages.flat()) : undefined;
    this.#models.set(
      runId,
      this.#trace.start(
        {
          kind: 'model',
          ...(input === undefined ? {} : { input }),
          ...(typeof provider === 'string' ? { provider } : {}),
          ...(typeof model === 'string' ? { model } : {}),
          ...(route === undefined ? {} : { route }),
        },
        parentRunId === undefined ? undefined : this.#chains.get(parentRunId)?.handle,
      ),
    );
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    const route = this.#routes.get(runId);
    const outputSafetyOutcome = this.#outputSafety.get(runId);
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
    const textOutput =
      this.#trace.recordsText && message !== undefined
        ? messagesText(
            [message as BaseMessage],
            typeof generation?.generationInfo?.['finish_reason'] === 'string'
              ? generation.generationInfo['finish_reason']
              : 'stop',
          )
        : undefined;
    this.#models.get(runId)?.end({
      status: 'ok',
      ...(textOutput === undefined ? {} : { output: textOutput }),
      ...(route === undefined ? {} : { route }),
      ...(outputSafetyOutcome === undefined ? {} : { outputSafetyOutcome }),
      usage: {
        ...(typeof input === 'number' ? { inputTokens: input } : {}),
        ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
      },
    });
    this.#models.delete(runId);
    this.#routes.delete(runId);
    this.#outputSafety.delete(runId);
  }

  override handleLLMError(error: Error, runId: string): void {
    const route = this.#routes.get(runId);
    const outputSafetyOutcome = this.#outputSafety.get(runId);
    this.#models.get(runId)?.end({
      status: 'error',
      errorType: this.isCredentialFailure(error) ? 'Error' : error.name,
      ...(route === undefined ? {} : { route }),
      ...(outputSafetyOutcome === undefined ? {} : { outputSafetyOutcome }),
    });
    this.#models.delete(runId);
    this.#routes.delete(runId);
    this.#outputSafety.delete(runId);
  }
}
