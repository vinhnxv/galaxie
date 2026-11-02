// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  BaseLlm,
  FunctionTool,
  InMemoryRunner,
  LlmAgent,
  type LlmRequest,
  type LlmResponse,
} from '@google/adk';
import { z } from 'zod';

export const CANARY_PROMPT = 'canary-prompt-7f3a';
export const CANARY_REPLY = 'canary-reply-91bc';
export const CANARY_ARGUMENT = 'canary-argument-52de';
export const CANARY_RESULT = 'canary-result-ad04';

export interface ProbeResult {
  readonly text: string;
  readonly authors: readonly string[];
  readonly calls: readonly string[];
  readonly toolInput: unknown;
  readonly network: readonly string[];
  readonly functionConstructions: number;
  readonly hadProcess: boolean;
  /** Empty from `runProbe`; the strict-CSP page fills it from `securitypolicyviolation` events. */
  readonly violations: readonly string[];
}

type Model = Pick<LlmRequest, 'contents'>;

export class ProbeLlm extends BaseLlm {
  readonly seen: Model[] = [];

  constructor() {
    super({ model: 'galaxie-probe' });
  }

  override async *generateContentAsync(request: LlmRequest): AsyncGenerator<LlmResponse, void> {
    this.seen.push({ contents: structuredClone(request.contents) });
    const answered = request.contents.some((content) =>
      content.parts?.some((part) => part.functionResponse !== undefined),
    );
    yield answered
      ? { content: { role: 'model', parts: [{ text: CANARY_REPLY }] }, turnComplete: true }
      : {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'echo', args: { value: CANARY_ARGUMENT } } }],
          },
          turnComplete: true,
        };
  }

  override async connect(): Promise<never> {
    throw new Error('The probe model has no live connection.');
  }
}

function blockNetwork(record: string[]): () => void {
  const originals = {
    fetch: Reflect.get(globalThis, 'fetch'),
    WebSocket: Reflect.get(globalThis, 'WebSocket'),
    XMLHttpRequest: Reflect.get(globalThis, 'XMLHttpRequest'),
    EventSource: Reflect.get(globalThis, 'EventSource'),
  };
  const blocked = (name: string) =>
    function blockedNetworkCall(): never {
      record.push(name);
      throw new Error(`blocked ${name}`);
    };
  for (const name of ['fetch', 'WebSocket', 'XMLHttpRequest', 'EventSource'] as const) {
    if (originals[name] !== undefined) Reflect.set(globalThis, name, blocked(name));
  }
  const beacon = Reflect.get(globalThis.navigator ?? {}, 'sendBeacon');
  if (typeof beacon === 'function')
    Reflect.set(globalThis.navigator, 'sendBeacon', blocked('sendBeacon'));
  return () => {
    for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
      if (originals[name] !== undefined) Reflect.set(globalThis, name, originals[name]);
    }
    if (typeof beacon === 'function') Reflect.set(globalThis.navigator, 'sendBeacon', beacon);
  };
}

function countFunctionConstructions(counter: { count: number }): () => void {
  const original = globalThis.Function;
  const wrapped = new Proxy(original, {
    construct(target, args, newTarget): object {
      counter.count += 1;
      return Reflect.construct(target, args, newTarget === wrapped ? target : newTarget);
    },
    apply(target, thisArg, args): unknown {
      counter.count += 1;
      return Reflect.apply(target, thisArg, args);
    },
  });
  Reflect.set(globalThis, 'Function', wrapped);
  return () => {
    Reflect.set(globalThis, 'Function', original);
  };
}

export async function runProbe(): Promise<ProbeResult> {
  const network: string[] = [];
  const functionCounter = { count: 0 };
  const hadProcess = typeof Reflect.get(globalThis, 'process') !== 'undefined';
  const restoreNetwork = blockNetwork(network);
  const restoreFunction = countFunctionConstructions(functionCounter);
  try {
    const toolInput: { value?: unknown } = {};
    const echo = new FunctionTool({
      name: 'echo',
      description: 'Echo a value.',
      parameters: z.object({ value: z.string() }),
      execute: async (input: { value: string }) => {
        toolInput.value = input.value;
        return { echoed: CANARY_RESULT };
      },
    });
    const agent = new LlmAgent({
      name: 'probe',
      model: new ProbeLlm(),
      instruction: 'Use the echo tool, then answer.',
      tools: [echo],
    });
    const runner = new InMemoryRunner({ agent, appName: 'probe' });
    const authors: string[] = [];
    const calls: string[] = [];
    let text = '';
    for await (const event of runner.runEphemeral({
      userId: 'probe-user',
      newMessage: { role: 'user', parts: [{ text: CANARY_PROMPT }] },
    })) {
      authors.push(event.author ?? '');
      for (const part of event.content?.parts ?? []) {
        if (part.functionCall?.name !== undefined) calls.push(part.functionCall.name);
        if (typeof part.text === 'string' && event.author === 'probe') text += part.text;
      }
    }
    return {
      text,
      authors,
      calls,
      toolInput: toolInput.value,
      network,
      functionConstructions: functionCounter.count,
      hadProcess,
      violations: [],
    };
  } finally {
    restoreFunction();
    restoreNetwork();
  }
}
