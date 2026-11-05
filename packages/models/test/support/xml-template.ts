// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/** Synthetic function/parameter template: no upstream template source is copied here. */
export const xmlTemplate: string = `
{%- if tools %}Tools: {{ tools | tojson }}{% endif -%}
{%- for message in messages %}
{{ message.role }}: {{ message.content }}
{%- if message.tool_calls %}
{%- for call in message.tool_calls %}
<tool_call>
<function={{ call.function.name }}>
{%- for key, value in call.function.arguments | items %}
<parameter={{ key }}>{{ value }}</parameter>
{%- endfor %}
</function>
</tool_call>
{%- endfor %}
{%- endif %}
{%- endfor %}
{%- if add_generation_prompt %}assistant: {% endif %}`;
