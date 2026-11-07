// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import {
  type CapabilityBindingPolicy,
  type CapabilityPort,
  GalaxieError,
  type ModelCall,
  type ModelPort,
  toErrorInfo,
} from '@galaxie/core';
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MockChatModel } from '../../models/src/mock.js';
import { createHost } from '../src/host.js';
import { RoutedChatModel } from '../src/routed-chat-model.js';
import { LangGraphTraceHandler } from '../src/trace-handler.js';

const readPolicy: CapabilityBindingPolicy = {
  kind: 'read',
  approval: 'none',
  confirmationAvailable: false,
};
const policy = vi.hoisted<{ current: CapabilityBindingPolicy | undefined }>(() => ({
  current: undefined,
}));
vi.mock('@galaxie/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@galaxie/core')>()),
  capabilityBindingPolicy: vi.fn(() => policy.current),
}));

const parameters = z.object({ q: z.string() });
const declaration = tool(async ({ q }) => q, {
  name: 'echo_1',
  description: 'Echo a query.',
  schema: parameters,
});
const script = {
  go: {
    id: 'reply',
    text: '',
    toolCalls: [{ id: 'chosen', name: 'echo_1', args: { q: 'query' } }],
  },
};

function fixture(provider: BaseChatModel = new MockChatModel(script)) {
  policy.current = readPolicy;
  const checkOutput = vi.fn<ModelCall['checkOutput']>(async () => {});
  const end = vi.fn<ModelCall['end']>();
  const fail = vi.fn<ModelCall['fail']>();
  const begin = vi.fn<ModelPort['begin']>(async () => ({
    providerId: 'local',
    destination: 'in-browser',
    maxTokens: 64,
    checkOutput,
    end,
    fail,
    outputSafetyOutcome: 'unset',
  }));
  const handler = new LangGraphTraceHandler({ recordsText: false, start: () => ({ end() {} }) });
  const capabilities: CapabilityPort = { call: vi.fn(async () => 'result') };
  const active = () => ({ capabilities, models: { begin }, handler });
  return {
    model: new RoutedChatModel('assistant', { local: provider }, active),
    active,
    begin,
    checkOutput,
    end,
    fail,
    capabilities,
  };
}

test('binding is lazy, requests tool calling and leaves the original routed model unbound', async () => {
  const provider = new MockChatModel(script);
  const f = fixture(provider);
  const bound = f.model.bindTools([declaration]);
  expect(f.begin).not.toHaveBeenCalled();
  expect(provider.calls).toBe(0);
  const message = await bound.invoke('go');
  expect(message.tool_calls).toMatchObject([{ name: 'echo_1', args: { q: 'query' } }]);
  expect(f.begin).toHaveBeenCalledWith('assistant', { requires: ['tool-calling'] });
  expect(f.checkOutput).toHaveBeenCalledWith('\n{"q":"query"}', { final: true });
  expect(f.end).toHaveBeenCalledTimes(1);
  // The unbound mock refuses calls to declarations it has never been offered.
  await expect(f.model.invoke('go')).rejects.toThrow('The mock tool call was not offered.');
});

test('a router feature rejection occurs before provider binding or dispatch', async () => {
  const provider = new MockChatModel(script);
  const bind = vi.spyOn(provider, 'bindTools');
  const f = fixture(provider);
  f.begin.mockRejectedValue(new GalaxieError('unsupported', toErrorInfo('unsupported').message));
  await expect(f.model.bindTools([declaration]).invoke('go')).rejects.toMatchObject({
    code: 'unsupported',
  });
  expect(bind).not.toHaveBeenCalled();
  expect(provider.calls).toBe(0);
});

class TextOnlyModel extends BaseChatModel {
  calls = 0;
  constructor() {
    super({});
  }
  override _llmType(): string {
    return 'text-only';
  }
  override async _generate(): Promise<ChatResult> {
    this.calls++;
    return { generations: [{ text: 'done', message: new AIMessage('done') }] };
  }
}

test('a selected implementation without bindTools fails unsupported without dispatch', async () => {
  const provider = new TextOnlyModel();
  const f = fixture(provider);
  await expect(f.model.bindTools([declaration]).invoke('go')).rejects.toMatchObject({
    code: 'unsupported',
  });
  expect(provider.calls).toBe(0);
  expect(f.fail).toHaveBeenCalledTimes(1);
});

interface BindingOptions extends BaseChatModelCallOptions {
  readonly tools?: BindToolsInput[];
}
class BindingModel extends BaseChatModel<BindingOptions> {
  readonly seen: unknown[] = [];
  constructor() {
    super({});
  }
  override _llmType(): string {
    return 'binding';
  }
  override bindTools(tools: BindToolsInput[]) {
    return this.withConfig({ tools: tools.map((entry) => convertToOpenAITool(entry)) });
  }
  override async _generate(
    _messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    this.seen.push(options.tools);
    return { generations: [{ text: 'done', message: new AIMessage('done') }] };
  }
}

test.each(['invoke', 'stream'] as const)(
  'provider RunnableBinding declarations survive %s',
  async (mode) => {
    const provider = new BindingModel();
    const f = fixture(provider);
    const model = f.model.bindTools([declaration]);
    if (mode === 'invoke') {
      await model.invoke('go');
    } else {
      for await (const _chunk of await model.stream('go')) {
        /* drain */
      }
    }
    expect(provider.seen).toEqual([[convertToOpenAITool(declaration)]]);
    expect(f.end).toHaveBeenCalledTimes(1);
  },
);

test('tools and structured output require both provider features', async () => {
  const provider = new MockChatModel({ go: { id: 'json', text: '{"ok":true}' } });
  const f = fixture(provider);
  await f.model.invoke('go', { tools: [declaration], jsonSchema: { type: 'object' } });
  expect(f.begin.mock.calls[0]?.[1]?.requires).toEqual(['tool-calling', 'structured-output']);
});

test.each(['invoke', 'stream'] as const)(
  'tool-call arguments blocked by output safety fail denied on %s',
  async (mode) => {
    const f = fixture();
    f.checkOutput.mockRejectedValue(new GalaxieError('denied', toErrorInfo('denied').message));
    const model = f.model.bindTools([declaration]);
    const invoke = async (): Promise<void> => {
      if (mode === 'invoke') {
        await model.invoke('go');
      } else {
        for await (const _chunk of await model.stream('go')) {
          /* drain */
        }
      }
    };
    await expect(invoke()).rejects.toMatchObject({ code: 'denied' });
    expect(f.end).not.toHaveBeenCalled();
    expect(f.fail).toHaveBeenCalledTimes(1);
  },
);

test.each(['denied', 'invalid', 'unavailable', 'timeout'] as const)(
  'capability helpers return only fixed recoverable %s errors and throw fatal failures',
  async (code) => {
    const f = fixture();
    const host = createHost({ chatModels: {} }, f.capabilities, undefined, f.active);
    vi.mocked(f.capabilities.call).mockRejectedValue(
      new GalaxieError(code, 'private-canary-error'),
    );
    const capability = host.langchain.capabilityTool('echo@1', {
      description: 'Echo.',
      parameters,
    });
    if (code === 'denied' || code === 'invalid') {
      expect(await capability.invoke({ q: 'private-canary-argument' })).toEqual({
        error: toErrorInfo(code).message,
      });
    } else {
      await expect(capability.invoke({ q: 'private-canary-argument' })).rejects.toMatchObject({
        code,
      });
    }
  },
);

test.each([
  { name: 'no broker policy', current: undefined },
  { name: 'a write without approval', current: { ...readPolicy, kind: 'write' as const } },
  {
    name: 'a device capability without approval',
    current: { ...readPolicy, kind: 'device' as const },
  },
  {
    name: 'a ui capability without a configured confirmation',
    current: { ...readPolicy, kind: 'ui' as const, approval: 'confirm' as const },
  },
])('the helper refuses $name before dispatch and before the tool is offered', async (entry) => {
  const provider = new MockChatModel(script);
  const f = fixture(provider);
  policy.current = entry.current;
  const host = createHost({ chatModels: {} }, f.capabilities, undefined, f.active);
  const capability = host.langchain.capabilityTool('echo@1', { description: 'Echo.', parameters });
  await expect(f.model.bindTools([capability]).invoke('go')).rejects.toMatchObject({
    code: 'invalid',
  });
  await expect(capability.invoke({ q: 'x' })).rejects.toMatchObject({ code: 'invalid' });
  expect(f.begin).not.toHaveBeenCalled();
  expect(provider.calls).toBe(0);
  expect(f.capabilities.call).not.toHaveBeenCalled();
});

test('a confirmed write with a configured confirmation is offered', async () => {
  const f = fixture();
  policy.current = { kind: 'write', approval: 'confirm', confirmationAvailable: true };
  const host = createHost({ chatModels: {} }, f.capabilities, undefined, f.active);
  const capability = host.langchain.capabilityTool('echo@1', { description: 'Echo.', parameters });
  const message = await f.model.bindTools([capability]).invoke('go');
  expect(message.tool_calls).toMatchObject([{ name: 'echo_1' }]);
});

test('two declarations with one tool name fail invalid before any lease', async () => {
  const f = fixture();
  const other = tool(async () => 'other', {
    name: 'echo_1',
    description: 'Other.',
    schema: parameters,
  });
  await expect(f.model.bindTools([declaration, other]).invoke('go')).rejects.toMatchObject({
    code: 'invalid',
  });
  expect(f.begin).not.toHaveBeenCalled();
});
