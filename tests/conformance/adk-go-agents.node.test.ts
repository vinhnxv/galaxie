// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  createRuntime,
  defineAgentDefinition,
  GalaxieError,
  type SessionId,
  type UserInteractionEvent,
} from '@galaxie-ai/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createGoAdapter } from '../../packages/adapter-go/src/index.js';
import { MemoryRecoveryStore } from '../../packages/core/test/support/memory-recovery-store.js';
import {
  buildReference,
  disposeReference,
  goAvailable,
  missingGo,
  type NodeHost,
  startNodeHost,
} from './support/adk-go.node.js';
import { MemoryByteCheckpoints } from './support/memory-byte-checkpoints.js';

let host: NodeHost | undefined;
beforeAll(async () => {
  if (goAvailable) host = await startNodeHost(await buildReference());
}, 600000);
afterAll(async () => {
  await host?.close();
  await disposeReference();
});

type Branch = 'left' | 'right' | 'final';

/**
 * Answers each branch of the parallel agent by the name in its instruction, not by arrival order.
 * A branch's first request is delayed by `delays`, so a test controls which branch reaches the
 * capability broker first.
 */
class BranchModel extends BaseChatModel {
  /** The branches in the order their first reply left the model. */
  readonly replied: Branch[] = [];
  readonly #delays: Partial<Record<Branch, number>>;
  constructor(delays: Partial<Record<Branch, number>>) {
    super({});
    this.#delays = delays;
  }
  override _llmType(): string {
    return 'galaxie-adk-go-branch';
  }
  override bindTools(): BranchModel {
    return this;
  }
  override async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const instruction = messages.map((message) => String(message.content)).join('\n');
    const branch = /Your internal name is "(left|right|final)"/.exec(instruction)?.[1] as
      | Branch
      | undefined;
    if (branch === undefined) throw new GalaxieError('invalid', 'The request names no branch.');
    const answered = messages.find((message) => message.getType() === 'tool');
    if (answered === undefined) {
      await new Promise((resolve) => setTimeout(resolve, this.#delays[branch] ?? 0));
      this.replied.push(branch);
      const message = new AIMessage({
        content: '',
        tool_calls: [
          {
            id: `call-${branch}`,
            name: 'math_double_1',
            args: { value: { left: 1, right: 2, final: 21 }[branch] },
          },
        ],
      });
      return { generations: [{ text: '', message }] };
    }
    return {
      generations: [
        { text: `${branch} done`, message: new AIMessage({ content: `${branch} done` }) },
      ],
    };
  }
}

const writing = defineAgentDefinition({
  id: 'conformance/adk-go-parallel-writes',
  version: '1.0.0',
  executor: 'adk-go',
  input: z.object({ prompt: z.string() }),
  capabilities: {
    required: {
      'math.double@1': {
        kind: 'write',
        input: z.object({ value: z.number() }),
        output: z.object({ value: z.number() }),
      },
    },
  },
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
});

interface CapabilityFrame {
  readonly effectScope: string;
  readonly input: { readonly value: number };
}

/** Opens a runtime over the real wasm with a write binding that records what it was asked to write. */
async function open(
  entry: string,
  model: BranchModel,
  shared: {
    readonly recovery: MemoryRecoveryStore;
    readonly bytes?: MemoryByteCheckpoints;
    readonly writes: number[];
    readonly frames: CapabilityFrame[];
  },
  sessionId?: SessionId,
) {
  const nodeHost = host;
  if (!nodeHost) throw new Error('The host did not start.');
  const runtime = createRuntime({
    appId: 'adk-go-parallel-writes',
    executors: [
      createGoAdapter({
        createWorker: () => {
          const port = nodeHost.createWorker();
          port.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') return;
            const message = JSON.parse(event.data) as {
              kind: string;
              op?: string;
              payload?: string;
            };
            if (message.kind === 'call' && message.op === 'capability' && message.payload)
              shared.frames.push(JSON.parse(message.payload) as CapabilityFrame);
          });
          return port;
        },
      }),
    ],
    budgets: { steps: 20, toolCalls: 10, tokens: 5000 },
    outputSafety: () => 'allow',
  });
  const instance = await runtime.create(writing, {
    principalScope: 'fixture',
    ...(sessionId === undefined ? {} : { sessionId }),
    recovery: shared.recovery,
    agent: { wasm: nodeHost.wasm, entry },
    services: {
      chatModels: { mock: model },
      ...(shared.bytes === undefined ? {} : { checkpoints: shared.bytes }),
    },
    bindings: {
      'math.double@1': {
        kind: 'write',
        destination: 'in-browser',
        timeoutMs: 5000,
        concurrency: 2,
        grantScope: 'instance',
        approval: 'none',
        retry: 'none',
        async invoke(input: { value: number }) {
          shared.writes.push(input.value);
          return { value: input.value * 2 };
        },
      },
    },
    models: {
      providers: {
        mock: {
          destination: 'in-browser',
          modality: 'text',
          features: ['tool-calling'],
          languages: ['en'],
          pricing: { inputPerToken: 0, outputPerToken: 0 },
        },
      },
      roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
    },
  });
  await instance.prepare();
  return { runtime, instance };
}
type Open = Awaited<ReturnType<typeof open>>;
const status = (current: Open) => current.instance.getSnapshot().run?.status;

test.skipIf(!goAvailable)(
  goAvailable
    ? 'parallel write branches keep their own effect scopes whichever branch asks the model first'
    : missingGo,
  async () => {
    const scopes: string[][] = [];
    for (const delays of [
      { left: 0, right: 80 },
      { left: 80, right: 0 },
    ]) {
      const shared = {
        recovery: new MemoryRecoveryStore(),
        writes: [] as number[],
        frames: [] as CapabilityFrame[],
      };
      const model = new BranchModel(delays);
      const current = await open('parallel-writes', model, shared);
      try {
        await current.instance.start({ prompt: 'Double both.' });
        await vi.waitFor(() => expect(status(current)).toBe('succeeded'));
        const order = delays.left === 0 ? ['left', 'right'] : ['right', 'left'];
        expect(model.replied).toEqual(order);
        // The capability calls reached the broker in the same order as the model replies.
        expect(
          shared.frames.map((frame) => frame.effectScope.split('/')[2]?.replace('fan.', '')),
        ).toEqual(order);
        expect([...shared.writes].sort()).toEqual([1, 2]);
        scopes.push(shared.frames.map((frame) => frame.effectScope).sort());
      } finally {
        await current.runtime.dispose();
      }
    }
    // One scope per branch, the same in both arrival orders, and no two branches share one.
    expect(scopes[0]).toEqual(scopes[1]);
    expect(new Set(scopes[0]).size).toBe(2);
    expect(scopes[0]?.map((scope) => scope.split('/')[2]).sort()).toEqual([
      'fan.left',
      'fan.right',
    ]);
  },
  120000,
);

test.skipIf(!goAvailable)(
  goAvailable
    ? 'a restore after the pause that follows a parallel stage does not run the branch writes again'
    : missingGo,
  async () => {
    const shared = {
      recovery: new MemoryRecoveryStore(),
      bytes: new MemoryByteCheckpoints(),
      writes: [] as number[],
      frames: [] as CapabilityFrame[],
    };
    const approval = (current: Open): UserInteractionEvent => {
      const run = current.instance.getSnapshot().run;
      if (run?.pending === undefined) throw new Error('The run did not pause.');
      return {
        instanceId: current.instance.instanceId,
        runId: run.runId,
        ...run.pending,
        action: 'approve',
        payload: { indexes: [0] },
      };
    };
    const first = await open('parallel-confirm', new BranchModel({ left: 60, right: 0 }), shared);
    let sessionId: SessionId;
    try {
      await first.instance.start({ prompt: 'Double all.' });
      await vi.waitFor(() => expect(status(first)).toBe('waiting_input'));
      expect([...shared.writes].sort((a, b) => a - b)).toEqual([1, 2]);
      sessionId = first.instance.sessionId;
    } finally {
      await first.runtime.dispose();
    }

    // The branches would reach the broker in the other order in the new life, if they ran at all.
    const second = await open(
      'parallel-confirm',
      new BranchModel({ left: 0, right: 60 }),
      shared,
      sessionId,
    );
    try {
      expect(await second.instance.restore()).toBeDefined();
      await vi.waitFor(() => expect(status(second)).toBe('waiting_input'));
      await second.instance.dispatch(approval(second));
      await vi.waitFor(() => expect(status(second)).toBe('succeeded'));
      // Only the approved final write ran; neither branch write ran again.
      expect([...shared.writes].sort((a, b) => a - b)).toEqual([1, 2, 21]);
    } finally {
      await second.runtime.dispose();
    }
  },
  120000,
);
