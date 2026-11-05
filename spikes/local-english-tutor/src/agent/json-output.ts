// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

// Structured output from a small local model, in the shape of LangChain's ProviderStrategy: the
// model provider enforces the schema while it decodes. Here the provider is the page's own worker,
// which writes the reply's JSON structure from the section's schema and lets the model write the
// values (engine/json-guide.ts). The reply is then validated against the Zod schema, and a reply
// that fails gets a fixed number of repair attempts, like ToolStrategy's error handling.

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage, HumanMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import type { GenerationStats, JsonSchema } from '../engine/protocol.js';
import type { ChatWebGpuCallOptions } from './chat-model.js';

export interface Attempt {
  readonly text: string;
  readonly error?: string;
  readonly stats?: GenerationStats;
}

export class JsonOutputError extends Error {
  readonly attempts: readonly Attempt[];

  constructor(attempts: readonly Attempt[]) {
    super(attempts.at(-1)?.error ?? 'no valid JSON');
    this.name = 'JsonOutputError';
    this.attempts = attempts;
  }
}

function parseReply<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    // A guided reply is cut off only at the token limit or by an abort.
    return { ok: false, error: `the reply is not complete JSON: ${(error as Error).message}` };
  }
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

export interface JsonOptions {
  readonly maxNewTokens: number;
  readonly repairs: number;
  /** The node's config: callbacks, and the run's abort signal. */
  readonly config: RunnableConfig;
  /** Called with the reply so far, for progress display. */
  readonly onText?: (text: string) => void;
}

export async function generateJson<T>(
  model: BaseChatModel<ChatWebGpuCallOptions>,
  messages: readonly BaseMessage[],
  schema: z.ZodType<T>,
  options: JsonOptions,
): Promise<{ value: T; attempts: readonly Attempt[] }> {
  // The lesson's schemas use only what JsonSchema describes; the worker rejects anything else.
  const jsonSchema = z.toJSONSchema(schema) as JsonSchema;
  const attempts: Attempt[] = [];
  let conversation = [...messages];
  for (let attempt = 0; attempt <= options.repairs; attempt++) {
    const reply = await streamReply(model, conversation, jsonSchema, options);
    const parsed = parseReply(reply.text, schema);
    if (parsed.ok) {
      attempts.push(reply);
      return { value: parsed.value, attempts };
    }
    attempts.push({ ...reply, error: parsed.error });
    conversation = [
      ...messages,
      new AIMessage(reply.text),
      new HumanMessage(
        `That reply is not valid:\n${parsed.error}\nReply again with only the corrected JSON object.`,
      ),
    ];
  }
  throw new JsonOutputError(attempts);
}

async function streamReply(
  model: BaseChatModel<ChatWebGpuCallOptions>,
  conversation: readonly BaseMessage[],
  jsonSchema: JsonSchema,
  options: JsonOptions,
): Promise<Attempt> {
  const stream = await model.stream([...conversation], {
    ...options.config,
    maxNewTokens: options.maxNewTokens,
    jsonSchema,
  });
  let text = '';
  let stats: GenerationStats | undefined;
  for await (const chunk of stream) {
    text += chunk.text;
    stats = (chunk.response_metadata['stats'] as GenerationStats | undefined) ?? stats;
    options.onText?.(text);
  }
  return stats === undefined ? { text } : { text, stats };
}
