// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from '@langchain/core/language_models/base';
import {
  assembleStructuredOutputPipeline,
  createContentParser,
} from '@langchain/core/language_models/structured_output';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { type Runnable, RunnableLambda } from '@langchain/core/runnables';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import type { SerializableSchema } from '@langchain/core/utils/standard_schema';
import type { InteropZodType } from '@langchain/core/utils/types';
import { ModelError, ModelProviderError } from './errors.js';

export type OutputSchema<Output extends Record<string, unknown>> =
  | SerializableSchema<Output>
  | InteropZodType<Output>
  | Record<string, unknown>;

export function structuredOutput<RunOutput extends Record<string, unknown>>(
  model: Runnable<
    BaseLanguageModelInput,
    BaseMessage,
    RunnableConfig & { readonly jsonSchema?: Readonly<Record<string, unknown>> }
  >,
  schema: OutputSchema<RunOutput>,
  config?: StructuredOutputMethodOptions<boolean>,
):
  | Runnable<BaseLanguageModelInput, RunOutput>
  | Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: RunOutput }> {
  if (config?.method !== undefined && config.method !== 'jsonSchema')
    throw new ModelError('unsupported');
  let jsonSchema: Readonly<Record<string, unknown>>;
  try {
    jsonSchema = toJsonSchema(schema as Parameters<typeof toJsonSchema>[0]);
  } catch {
    throw new ModelError('invalid');
  }
  const parser = createContentParser<RunOutput>(schema);
  const safeParser = RunnableLambda.from<BaseMessage, RunOutput>(async (message) => {
    try {
      if (typeof message.content !== 'string') throw new ModelProviderError();
      // Avoid invoking parser callbacks with its content-bearing OutputParserException.
      return await parser.parseResult([{ text: message.content }]);
    } catch {
      throw new ModelProviderError();
    }
  });
  return assembleStructuredOutputPipeline(
    model.withConfig({ jsonSchema }),
    safeParser,
    config?.includeRaw,
  );
}
