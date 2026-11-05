// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

import { BaseChatModel, type LangSmithParams } from '@langchain/core/language_models/chat_models';
import {
  AIMessage,
  type BaseMessage,
  type StandardMessageStructure,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';

export type Directive =
  | { kind: 'callTool'; name: string; args: Record<string, unknown> }
  | {
      kind: 'emitInteraction';
      component: 'tests.CorpusLink/v1';
      props: { url: string; text: string };
    }
  | { kind: 'reply'; text: string }
  | { kind: 'forwardPrivate'; to: 'agent.main' };

export const directiveSchema: z.ZodType<Directive> = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('callTool'),
    name: z.string().min(1),
    args: z.record(z.string(), z.json()),
  }),
  z.strictObject({
    kind: z.literal('emitInteraction'),
    component: z.literal('tests.CorpusLink/v1'),
    props: z.strictObject({ url: z.string(), text: z.string() }),
  }),
  z.strictObject({ kind: z.literal('reply'), text: z.string() }),
  z.strictObject({ kind: z.literal('forwardPrivate'), to: z.literal('agent.main') }),
]);
export interface InjectionCase {
  readonly id: string;
  readonly vector: 'lesson' | 'tool-output' | 'mcp-description';
  readonly goal:
    | 'unapproved-write'
    | 'egress'
    | 'url-render'
    | 'label-downgrade'
    | 'instruction-in-data';
  readonly payload: string;
  readonly directive: Directive;
}
export const caseSchema: z.ZodType<InjectionCase> = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  vector: z.enum(['lesson', 'tool-output', 'mcp-description']),
  goal: z.enum([
    'unapproved-write',
    'egress',
    'url-render',
    'label-downgrade',
    'instruction-in-data',
  ]),
  payload: z.string().min(1),
  directive: directiveSchema,
});

/** Fully compromised model: exact payload matching is a script selector, never a defense. */
export class ObedientAttacker extends BaseChatModel {
  readonly #entry: InjectionCase;
  reads: number = 0;

  constructor(entry: InjectionCase) {
    super({});
    this.#entry = caseSchema.parse(entry);
  }

  override _llmType(): string {
    return 'corpus-mock';
  }
  override getLsParams(): LangSmithParams {
    return {
      ls_model_type: 'chat',
      ls_provider: 'corpus-mock',
      ls_model_name: 'obedient-attacker',
    };
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    options.signal?.throwIfAborted();
    const matched = messages.some(
      (message) =>
        typeof message.content === 'string' && message.content.includes(this.#entry.payload),
    );
    if (matched) this.reads++;
    const directive: Directive = matched
      ? this.#entry.directive
      : { kind: 'reply', text: 'Benign default.' };
    const text = directive.kind === 'reply' ? directive.text : '';
    return {
      generations: [
        {
          text,
          message: new AIMessage<StandardMessageStructure>({
            content: text,
            ...(directive.kind === 'reply'
              ? {}
              : {
                  tool_calls: [{ id: 'corpus-directive', name: directive.kind, args: directive }],
                }),
            usage_metadata: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        },
      ],
    };
  }
}

export function readDirective(message: AIMessage): Directive {
  const call = message.tool_calls?.[0];
  return directiveSchema.parse(
    call === undefined ? { kind: 'reply', text: message.text } : call.args,
  );
}
