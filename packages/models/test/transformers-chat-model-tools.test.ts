// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import {
  AIMessage,
  type AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { concat } from '@langchain/core/utils/stream';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TransformersChatModel } from '../src/transformers/chat-model.js';
import { createTransformersEngine } from '../src/transformers/engine.js';
import type { FakeRuntimeOptions } from './support/fake-transformers-runtime.js';
import { setup } from './support/transformers-loopback.js';
import { createSyntheticModel } from './support/transformers-model.js';

const lookup = tool(async () => 'unused', {
  name: 'lookup',
  description: 'Look something up.',
  schema: z.object({ q: z.string(), limit: z.number().optional() }),
});

const call = (name: string, args: unknown): string =>
  `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

async function fixture(runtime: FakeRuntimeOptions = {}, toolFormat: 'hermes' | 'none' = 'hermes') {
  const model = await createSyntheticModel(toolFormat === 'none' ? {} : { toolFormat });
  const parts = await setup({ model, runtime });
  const handle = await createTransformersEngine(
    { worker: parts.worker, model: parts.model.record, allowDownload: true },
    { gpu: undefined },
  );
  return { ...parts, handle, model: new TransformersChatModel(handle) };
}

describe('Transformers tool calling', () => {
  it('returns parsed tool calls with no tool text in the content and counts the block tokens', async () => {
    const { runtime, handle, model } = await fixture({
      pieces: [call('lookup', { q: 'x', limit: 2 })],
    });
    try {
      const reply = await model.bindTools([lookup]).invoke('find x');
      expect(reply.content).toBe('');
      expect(reply.tool_calls).toEqual([
        { type: 'tool_call', id: 'call_0', name: 'lookup', args: { q: 'x', limit: 2 } },
      ]);
      expect(reply.invalid_tool_calls ?? []).toEqual([]);
      expect(reply.response_metadata['finish_reason']).toBe('tool_calls');
      // The one piece is the whole block, and it is counted like any other generated token.
      expect(reply.usage_metadata).toEqual({ input_tokens: 5, output_tokens: 1, total_tokens: 6 });
      const [declared] = runtime.generations[0]?.request.tools ?? [];
      expect(declared).toMatchObject({
        type: 'function',
        function: { name: 'lookup', description: 'Look something up.' },
      });
      expect(JSON.stringify(runtime.generations[0]?.request)).not.toContain('undefined');
    } finally {
      await handle.dispose();
    }
  });

  it('accepts a declaration given as an OpenAI function object', async () => {
    const { runtime, handle, model } = await fixture({ pieces: ['ok'] });
    try {
      const declaration = {
        type: 'function',
        function: {
          name: 'ping',
          description: 'Ping.',
          parameters: { type: 'object', properties: {} },
        },
      };
      await model.bindTools([declaration]).invoke('go');
      expect(runtime.generations[0]?.request.tools).toEqual([declaration]);
    } finally {
      await handle.dispose();
    }
  });

  it('returns a malformed block as an invalid tool call that keeps the raw text', async () => {
    const { handle, model } = await fixture({
      pieces: ['Checking. ', '<tool_call>{"name": "lookup", "arguments": {"q"', '</tool_call>'],
    });
    try {
      const reply = await model.bindTools([lookup]).invoke('find x');
      expect(reply.content).toBe('Checking.');
      expect(reply.tool_calls ?? []).toEqual([]);
      expect(reply.invalid_tool_calls).toEqual([
        expect.objectContaining({
          type: 'invalid_tool_call',
          id: 'call_0',
          args: '{"name": "lookup", "arguments": {"q"',
        }),
      ]);
      expect(reply.response_metadata['finish_reason']).toBe('tool_calls');
    } finally {
      await handle.dispose();
    }
  });

  it('streams text first and then each complete block once with its own index', async () => {
    const { handle, model } = await fixture({
      pieces: [
        'Let me look. ',
        '<tool_call>{"name":"lookup",',
        '"arguments":{"q":"a"}}</tool_call>\n',
        call('lookup', { q: 'b' }),
      ],
    });
    try {
      const chunks: AIMessageChunk[] = [];
      for await (const chunk of await model.bindTools([lookup]).stream('find')) chunks.push(chunk);
      expect(chunks.map((chunk) => chunk.content).join('')).toBe('Let me look.');
      const withCalls = chunks.filter((chunk) => (chunk.tool_call_chunks?.length ?? 0) > 0);
      expect(withCalls.map((chunk) => chunk.tool_call_chunks)).toEqual([
        [expect.objectContaining({ index: 0, id: 'call_0', name: 'lookup', args: '{"q":"a"}' })],
        [expect.objectContaining({ index: 1, id: 'call_1', name: 'lookup', args: '{"q":"b"}' })],
      ]);
      // Text arrives before any call, and only the last chunk carries usage and the finish reason.
      expect(chunks.findIndex((chunk) => chunk.content !== '')).toBeLessThan(
        chunks.findIndex((chunk) => (chunk.tool_call_chunks?.length ?? 0) > 0),
      );
      expect(chunks.filter((chunk) => chunk.usage_metadata !== undefined)).toEqual([chunks.at(-1)]);
      expect(chunks.at(-1)?.response_metadata).toEqual({ finish_reason: 'tool_calls' });
      const joined = chunks.reduce((total, chunk) => concat(total, chunk));
      expect(joined.tool_calls?.map((item) => [item.id, item.args])).toEqual([
        ['call_0', { q: 'a' }],
        ['call_1', { q: 'b' }],
      ]);
    } finally {
      await handle.dispose();
    }
  });

  it.each([
    ['text that is not JSON', 'not json', 'not json', undefined],
    [
      'JSON with the wrong argument type',
      '{"name": "lookup", "arguments": [1]}',
      '{"name": "lookup", "arguments": [1]}',
      'lookup',
    ],
    [
      'a truncated block',
      '{"name": "lookup", "arguments": {"q": "x"',
      '{"name": "lookup", "arguments": {"q": "x"',
      undefined,
    ],
  ])(
    'streams a malformed block (%s) as an invalid call, never as argument fragments',
    async (_label, body, args, name) => {
      const { handle, model } = await fixture({ pieces: [`<tool_call>${body}</tool_call>`] });
      try {
        const chunks: AIMessageChunk[] = [];
        for await (const chunk of await model.bindTools([lookup]).stream('find'))
          chunks.push(chunk);
        // LangChain would repair argument fragments of a JSON-valid block into a valid call.
        expect(chunks.flatMap((chunk) => chunk.tool_call_chunks ?? [])).toEqual([]);
        expect(chunks.flatMap((chunk) => chunk.tool_calls ?? [])).toEqual([]);
        expect(chunks.flatMap((chunk) => chunk.invalid_tool_calls ?? [])).toEqual([
          expect.objectContaining({
            id: 'call_0',
            args,
            ...(name === undefined ? {} : { name }),
          }),
        ]);
      } finally {
        await handle.dispose();
      }
    },
  );

  it('streams the seventeenth block as an invalid call after sixteen valid ones', async () => {
    const { handle, model } = await fixture({
      pieces: Array.from({ length: 17 }, (_, index) => call('lookup', { q: String(index) })),
    });
    try {
      const chunks: AIMessageChunk[] = [];
      for await (const chunk of await model.bindTools([lookup]).stream('find')) chunks.push(chunk);
      expect(chunks.flatMap((chunk) => chunk.tool_call_chunks ?? [])).toHaveLength(16);
      expect(chunks.flatMap((chunk) => chunk.invalid_tool_calls ?? [])).toHaveLength(1);
    } finally {
      await handle.dispose();
    }
  });

  it('reports a reply cut off by the token limit as length, with the broken block invalid', async () => {
    const { handle, model } = await fixture({
      pieces: ['<tool_call>{"name": "lookup", "arguments": {"q": "x'],
      finishReason: 'length',
    });
    try {
      const reply = await model.bindTools([lookup]).invoke('find x');
      expect(reply.response_metadata['finish_reason']).toBe('length');
      expect(reply.tool_calls ?? []).toEqual([]);
      expect(reply.invalid_tool_calls).toHaveLength(1);
      expect(reply.content).toBe('');
    } finally {
      await handle.dispose();
    }
  });

  it('sends the assistant call and the tool turn in order for a history with a tool result', async () => {
    const { runtime, handle, model } = await fixture({ pieces: ['x is 3'] });
    try {
      const reply = await model.bindTools([lookup]).invoke([
        new SystemMessage('Be brief.'),
        new HumanMessage('find x'),
        new AIMessage({
          content: 'Looking.',
          tool_calls: [{ id: 'call_0', name: 'lookup', args: { q: 'x' } }],
        }),
        new ToolMessage({ content: '3', tool_call_id: 'call_0' }),
      ]);
      expect(reply.content).toBe('x is 3');
      expect(reply.response_metadata['finish_reason']).toBe('stop');
      expect(runtime.generations[0]?.request.messages).toEqual([
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'find x' },
        {
          role: 'assistant',
          content: 'Looking.',
          toolCalls: [{ name: 'lookup', arguments: { q: 'x' } }],
        },
        { role: 'tool', content: '3' },
      ]);
    } finally {
      await handle.dispose();
    }
  });

  it('treats tool_choice none as no tools and leaves a block in the reply as plain text', async () => {
    const { runtime, handle, model } = await fixture({ pieces: [call('lookup', { q: 'x' })] });
    try {
      const reply = await model.bindTools([lookup], { tool_choice: 'none' }).invoke('find x');
      expect(runtime.generations[0]?.request.tools).toBeUndefined();
      expect(reply.tool_calls ?? []).toEqual([]);
      expect(reply.content).toBe(call('lookup', { q: 'x' }));
      // A per-call none behaves the same on a model that has tools bound.
      const again = await model.bindTools([lookup]).invoke('find x', { tool_choice: 'none' });
      expect(runtime.generations[1]?.request.tools).toBeUndefined();
      expect(again.tool_calls ?? []).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it('accepts tool_choice auto', async () => {
    const { runtime, handle, model } = await fixture({ pieces: [call('lookup', { q: 'x' })] });
    try {
      const reply = await model.bindTools([lookup], { tool_choice: 'auto' }).invoke('find x');
      expect(reply.tool_calls).toHaveLength(1);
      expect(runtime.generations[0]?.request.tools).toHaveLength(1);
    } finally {
      await handle.dispose();
    }
  });

  it.each([
    ['required', 'required'],
    ['any', 'any'],
    ['a named tool', 'lookup'],
    ['a function object', { type: 'function', function: { name: 'lookup' } }],
  ])('fails unsupported for tool_choice %s, at bind time and per call', async (_label, choice) => {
    const { runtime, handle, model } = await fixture();
    try {
      expect(() => model.bindTools([lookup], { tool_choice: choice })).toThrow(
        expect.objectContaining({ code: 'unsupported' }),
      );
      await expect(
        model.bindTools([lookup]).invoke('find x', { tool_choice: choice }),
      ).rejects.toMatchObject({ code: 'unsupported' });
      expect(runtime.generations).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it('fails unsupported from bindTools when the record declares no tool format', async () => {
    const { runtime, handle, model } = await fixture({}, 'none');
    try {
      expect(() => model.bindTools([lookup])).toThrow(
        expect.objectContaining({ code: 'unsupported' }),
      );
      // Tool history is still refused as invalid input, as in the text-only model.
      await expect(
        model.invoke([
          new HumanMessage('find x'),
          new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'lookup', args: {} }] }),
          new ToolMessage({ content: '3', tool_call_id: 'a' }),
        ]),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(runtime.generations).toEqual([]);
    } finally {
      await handle.dispose();
    }
  });

  it('does not parse tool markup when no tools were offered', async () => {
    const reply = call('lookup', { q: 'x' });
    const { runtime, handle, model } = await fixture({ pieces: [reply] });
    try {
      const result = await model.invoke('find x');
      expect(result.content).toBe(reply);
      expect(result.tool_calls ?? []).toEqual([]);
      expect(runtime.generations[0]?.request.tools).toBeUndefined();
    } finally {
      await handle.dispose();
    }
  });

  it('keeps the handle shared and the original model free of tools after binding', async () => {
    const { runtime, handle, model } = await fixture({ pieces: ['hi'] });
    try {
      const bound = model.bindTools([lookup]);
      await bound.invoke('one');
      await model.invoke('two');
      expect(
        runtime.generations.map((generation) => generation.request.tools !== undefined),
      ).toEqual([true, false]);
    } finally {
      await handle.dispose();
    }
  });
});
