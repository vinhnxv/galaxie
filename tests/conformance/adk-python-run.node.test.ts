// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { createRuntime, defineAgentDefinition, GalaxieError, type RunEvent } from '@galaxie/core';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  type StandardMessageStructure,
  type ToolCall,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
  createPythonFixture,
  missingPythonWheels,
  pythonWheelsAvailable,
} from '../../examples/rag-browser/test/support/python.node.js';
import { createPyodideAdapter } from '../../packages/adapter-pyodide/src/adapter.js';

type Reply =
  | { readonly text: string; readonly toolCalls?: readonly ToolCall[] }
  | { readonly error: Error }
  | { readonly wait: Promise<void>; readonly entered: () => void };

/** Answers each call from the next scripted reply and records the history it was shown. */
class SequenceModel extends BaseChatModel {
  readonly requests: string[][] = [];
  readonly #replies: readonly Reply[];
  #index = 0;
  constructor(replies: readonly Reply[]) {
    super({});
    this.#replies = replies;
  }
  override _llmType(): string {
    return 'adk-python-sequence';
  }
  override bindTools(): this {
    return this;
  }
  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    this.requests.push(
      messages.map((message) => `${message.type}:${JSON.stringify(message.content)}`),
    );
    const reply = this.#replies[this.#index++];
    if (!reply) throw new Error('The sequence has no more replies.');
    if ('error' in reply) throw reply.error;
    if ('wait' in reply) {
      reply.entered();
      await Promise.race([
        reply.wait,
        new Promise<never>((_, reject) =>
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          }),
        ),
      ]);
      throw new Error('The waiting reply was released.');
    }
    return {
      generations: [
        {
          text: reply.text,
          message: new AIMessage<StandardMessageStructure>({
            content: reply.text,
            ...(reply.toolCalls ? { tool_calls: [...reply.toolCalls] } : {}),
            usage_metadata: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
          }),
        },
      ],
    };
  }
}

const agents = `
from google.adk.agents import LlmAgent
from galaxie.adk import Executor, capability_tool, llm
import os

PARAMETERS = {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']}

def double():
    return capability_tool('double', 'math.double@1', PARAMETERS, 'Double an integer.')

def plain():
    return LlmAgent(name='plain', model=llm('answer'), instruction='Answer briefly.')

def tools():
    return LlmAgent(name='tools', model=llm('answer'), instruction='Use the tools.', tools=[double()])

def swallowing():
    def swallow(tool, args, tool_context, error):
        return {'swallowed': True}
    return LlmAgent(
        name='swallowing', model=llm('answer'), instruction='Use the tools.', tools=[double()],
        on_tool_error_callback=swallow,
    )

class Direct(Executor):
    """Builds a Gemini-backed agent in the Worker, bypassing tree validation."""

    def __init__(self):
        pass

    def pending(self, session):
        return None

    async def run(self, input, session, steps, on_stream=None, resume=None):
        os.environ['GOOGLE_API_KEY'] = 'fixture-not-a-key'
        from google.adk.agents import LlmAgent as Agent
        from google.adk.runners import InMemoryRunner
        from google.genai import types
        runner = InMemoryRunner(agent=Agent(name='direct', model='gemini-2.5-flash'), app_name='direct')
        stored = await runner.session_service.create_session(app_name='direct', user_id='user')
        outcome = 'completed'
        try:
            async for _ in runner.run_async(
                user_id='user', session_id=stored.id,
                new_message=types.Content(role='user', parts=[types.Part(text='hello')]),
            ):
                pass
        except BaseException as error:
            outcome = type(error).__name__
        return {'outcome': outcome}

def direct():
    return Direct()

class Quiet(Executor):
    """Runs the real executor while capturing everything the run prints, logs or warns."""

    def __init__(self):
        super().__init__(tools())

    async def run(self, input, session, steps, on_stream=None, resume=None):
        import io, logging, sys, warnings
        captured = io.StringIO()
        handler = logging.StreamHandler(captured)
        logging.getLogger().addHandler(handler)
        logging.getLogger().setLevel(logging.DEBUG)
        previous = sys.stdout, sys.stderr
        sys.stdout = sys.stderr = captured
        try:
            with warnings.catch_warnings(record=True) as recorded:
                warnings.simplefilter('always')
                output = await super().run(input, session, steps, on_stream, resume)
        finally:
            sys.stdout, sys.stderr = previous
            logging.getLogger().removeHandler(handler)
        return {'output': output, 'captured': captured.getvalue(), 'warnings': [str(item.message) for item in recorded]}

def quiet():
    return Quiet()
`;

const definition = defineAgentDefinition({
  id: 'tests/adk-python',
  version: '1.0.0',
  executor: 'adk-python',
  input: z.object({ prompt: z.string() }),
  models: { answer: { modality: 'text', languages: ['en'], defaultPolicy: 'local-only' } },
  capabilities: {
    required: {
      'math.double@1': {
        kind: 'read',
        input: z.object({ value: z.number().int() }),
        output: z.object({ value: z.number().int() }),
      },
    },
  },
});
const call = (id: string, value: number): ToolCall => ({ id, name: 'double', args: { value } });
interface Outcome {
  readonly output?: unknown;
  readonly error?: { code: string };
  readonly cancelled: boolean;
}

test.skipIf(!pythonWheelsAvailable)(
  pythonWheelsAvailable
    ? 'ADK Python runs inside the Worker with fixed failure codes'
    : missingPythonWheels,
  async () => {
    const fixture = await createPythonFixture({
      framework: 'adk',
      module: 'agents',
      sources: { 'agents.py': agents },
    });
    const invoked: number[] = [];
    let behavior: 'double' | 'unavailable' = 'double';
    const runtime = createRuntime({
      appId: 'adk-python-run',
      executors: [createPyodideAdapter({ ...fixture.options, framework: 'adk' })],
      budgets: { steps: 10, toolCalls: 10, tokens: 5000 },
      outputSafety: () => 'allow',
    });
    async function open(entry: string, replies: readonly Reply[]) {
      const model = new SequenceModel(replies);
      const instance = await runtime.create(definition, {
        principalScope: 'fixture',
        agent: { ...fixture.agent, entry },
        services: { chatModels: { mock: model } },
        bindings: {
          'math.double@1': {
            kind: 'read',
            destination: 'in-browser',
            timeoutMs: 1000,
            concurrency: 4,
            grantScope: 'instance',
            approval: 'none',
            retry: 'none',
            async invoke(input: { value: number }) {
              invoked.push(input.value);
              if (behavior === 'unavailable')
                throw new GalaxieError('unavailable', 'The requested service is unavailable.');
              return { value: input.value * 2 };
            },
          },
        },
        models: {
          providers: {
            mock: {
              destination: 'in-browser',
              modality: 'text',
              languages: ['en'],
              features: ['tool-calling', 'structured-output', 'streaming'],
              pricing: { inputPerToken: 0, outputPerToken: 0 },
            },
          },
          roles: { answer: { providers: ['mock'], allow: ['in-browser'], maxTokens: 100 } },
        },
      });
      await instance.prepare();
      const run = async (prompt: string, cancelWhen?: Promise<void>): Promise<Outcome> => {
        const { runId } = await instance.start({ prompt });
        const events = (async () => {
          const recorded: RunEvent[] = [];
          for await (const event of instance.events(runId)) recorded.push(event);
          return recorded;
        })();
        if (cancelWhen) {
          await cancelWhen;
          await instance.cancel(runId);
        }
        const result: { output?: unknown; error?: { code: string }; cancelled: boolean } = {
          cancelled: false,
        };
        for (const event of await events) {
          if (event.type === 'output') result.output = event.output;
          else if (event.type === 'error') result.error = event.error;
          else if (event.type === 'cancelled') result.cancelled = true;
        }
        return result;
      };
      return { model, run };
    }
    try {
      // A model that raises ends the run with the raised code, not a model-visible message.
      {
        const { run } = await open('plain', [{ error: new Error('PRIVATE PROVIDER DETAIL') }]);
        expect((await run('boom')).error?.code).toBe('unavailable');
      }
      // A capability that fails fatally ends the run; the model never sees the failure.
      {
        behavior = 'unavailable';
        invoked.length = 0;
        const { model, run } = await open('tools', [
          { text: '', toolCalls: [call('a', 1)] },
          { text: 'never' },
        ]);
        expect((await run('one')).error?.code).toBe('unavailable');
        expect(model.requests).toHaveLength(1);
        expect(invoked).toEqual([1]);
      }
      // An author callback that swallows the tool error cannot keep the run going.
      {
        invoked.length = 0;
        const { model, run } = await open('swallowing', [
          { text: '', toolCalls: [call('a', 1)] },
          { text: 'never' },
        ]);
        expect((await run('one')).error?.code).toBe('unavailable');
        expect(model.requests).toHaveLength(1);
      }
      // The second of two sibling tools is never dispatched after the first fails fatally.
      {
        invoked.length = 0;
        const { run } = await open('tools', [
          { text: '', toolCalls: [call('a', 1), call('b', 2)] },
          { text: 'never' },
        ]);
        expect((await run('two')).error?.code).toBe('unavailable');
        expect(invoked).toEqual([1]);
      }
      // A failed run leaves the session at its last stored point.
      {
        behavior = 'double';
        const { model, run } = await open('tools', [
          { text: 'first' },
          { text: '', toolCalls: [call('a', 1)] },
          { error: new Error('PRIVATE PROVIDER DETAIL') },
          { text: 'second' },
        ]);
        expect((await run('one')).output).toBe('first');
        expect((await run('two')).error?.code).toBe('unavailable');
        expect((await run('three')).output).toBe('second');
        expect(model.requests.at(-1)?.filter((line) => !line.startsWith('system:'))).toEqual([
          'human:"one"',
          'ai:"first"',
          'human:"three"',
        ]);
      }
      // Abort settles cancelled within a bound and the adapter then serves another run.
      {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const { model, run } = await open('plain', [
          { wait: release.promise, entered: () => entered.resolve() },
          { text: 'again' },
        ]);
        const started = Date.now();
        const aborted = await run('slow', entered.promise);
        release.resolve();
        expect(aborted.cancelled).toBe(true);
        expect(Date.now() - started).toBeLessThan(5000);
        expect((await run('next')).output).toBe('again');
        expect(model.requests.at(-1)?.filter((line) => !line.startsWith('system:'))).toEqual([
          'human:"next"',
        ]);
      }
      // A Gemini-backed agent built directly in the Worker fails; the Worker's fetch stub rejects external origins.
      {
        const before = fixture.requests.length;
        const { run } = await open('direct', []);
        const direct = await run('hello');
        expect(direct.output).toMatchObject({ outcome: expect.any(String) });
        expect((direct.output as { outcome: string }).outcome).not.toBe('completed');
        expect(
          fixture.requests.slice(before).every((record) => record.url.startsWith('/python/')),
        ).toBe(true);
      }
      // Framework warnings, ADK loggers and prints emit nothing during a normal tool run.
      {
        behavior = 'double';
        const { run } = await open('quiet', [
          { text: '', toolCalls: [call('a', 3)] },
          { text: 'six' },
        ]);
        const quiet = await run('quiet');
        expect(quiet.output).toEqual({ output: 'six', captured: '', warnings: [] });
      }
      expect(fixture.workerErrors).toEqual([]);
    } finally {
      await runtime.dispose();
      await fixture.cleanup();
    }
  },
  240000,
);
