// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

import { Template } from '@huggingface/jinja';
import type { GenerateRequest } from '../../src/transformers/protocol.js';
import { templateMessages } from '../../src/transformers/runtime.js';

/**
 * A chat template in the Hermes style, modeled on the format Qwen2.5 publishes: tools listed in
 * a system turn, calls written as `<tool_call>` blocks and results returned in `<tool_response>`
 * blocks inside a user turn. It stands in for a real model's template so a request shape error
 * shows up without a model.
 */
export const hermesTemplate = `
{%- if tools %}
  {{- '<|im_start|>system\\n' }}
  {%- if messages[0]['role'] == 'system' %}
    {{- messages[0]['content'] }}
  {%- else %}
    {{- 'You are a helpful assistant.' }}
  {%- endif %}
  {{- "\\n\\n# Tools\\n\\nYou are provided with function signatures within <tools></tools> XML tags:\\n<tools>" }}
  {%- for tool in tools %}
    {{- "\\n" }}
    {{- tool | tojson }}
  {%- endfor %}
  {{- "\\n</tools>\\n\\nFor each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:\\n<tool_call>\\n{\\"name\\": <function-name>, \\"arguments\\": <args-json-object>}\\n</tool_call><|im_end|>\\n" }}
{%- elif messages[0]['role'] == 'system' %}
  {{- '<|im_start|>system\\n' + messages[0]['content'] + '<|im_end|>\\n' }}
{%- endif %}
{%- for message in messages %}
  {%- if (message.role == "user") or (message.role == "system" and not loop.first) or (message.role == "assistant" and not message.tool_calls) %}
    {{- '<|im_start|>' + message.role + '\\n' + message.content + '<|im_end|>' + '\\n' }}
  {%- elif message.role == "assistant" %}
    {{- '<|im_start|>' + message.role }}
    {%- if message.content %}
      {{- '\\n' + message.content }}
    {%- endif %}
    {%- for tool_call in message.tool_calls %}
      {%- if tool_call.function is defined %}
        {%- set tool_call = tool_call.function %}
      {%- endif %}
      {{- '\\n<tool_call>\\n{"name": "' }}
      {{- tool_call.name }}
      {{- '", "arguments": ' }}
      {{- tool_call.arguments | tojson }}
      {{- '}\\n</tool_call>' }}
    {%- endfor %}
    {{- '<|im_end|>\\n' }}
  {%- elif message.role == "tool" %}
    {%- if (loop.index0 == 0) or (messages[loop.index0 - 1].role != "tool") %}
      {{- '<|im_start|>user' }}
    {%- endif %}
    {{- '\\n<tool_response>\\n' }}
    {{- message.content }}
    {{- '\\n</tool_response>' }}
    {%- if loop.last or (messages[loop.index0 + 1].role != "tool") %}
      {{- '<|im_end|>\\n' }}
    {%- endif %}
  {%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}
  {{- '<|im_start|>assistant\\n' }}
{%- endif %}
`;

/** Renders a request the way the runtime hands it to the tokenizer's template. */
export function renderHermes(request: GenerateRequest): string {
  return new Template(hermesTemplate).render({
    messages: templateMessages(request),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    add_generation_prompt: true,
  });
}
