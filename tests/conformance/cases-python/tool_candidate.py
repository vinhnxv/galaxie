# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Unshipped measurement candidate. A failed safety floor forbids promotion.

No latch is installed: public checkpoint namespaces identify individual tasks,
and thread_id identifies a session, not an execution. A thread-keyed latch would
poison later executions; a task-keyed latch would miss the next model node.
Streaming mapping is intentionally unreached after that decisive floor failure.
"""

import json
import re
from typing import Any

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import StructuredTool

from galaxie import GalaxieError, capabilities
from galaxie._bridge import request
from galaxie.langchain import GalaxieChatModel


class CapabilityTool(StructuredTool):
    """Test-local marker; ordinary tools cannot be offered by this candidate."""


def capability_tool(name, capability, parameters, description):
    if (not isinstance(name, str) or re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,63}', name) is None
        or not isinstance(capability, str) or not capability
        or not isinstance(parameters, dict) or parameters.get('type') != 'object'
        or not isinstance(description, str)):
        raise GalaxieError('invalid')
    try:
        schema = json.loads(json.dumps(parameters, allow_nan=False))
        if len(json.dumps(schema).encode()) > 1_048_576:
            raise GalaxieError('unsupported')
    except (ValueError, TypeError, UnicodeError):
        raise GalaxieError('invalid') from None

    async def invoke(config: RunnableConfig, **arguments):
        try:
            result = await capabilities.call(capability, arguments, config, tool=True)
            return result if isinstance(result, str) else json.dumps(result, separators=(',', ':'))
        except GalaxieError as error:
            if error.code == 'denied':
                return 'Policy denied the request.'
            raise

    return CapabilityTool(name=name, description=description, args_schema=schema, coroutine=invoke)


class ToolCandidate(GalaxieChatModel):
    declarations: list[dict[str, Any]] = []
    choice: Any = None

    def bind_tools(self, tools: Any, *, tool_choice=None, **kwargs):
        if kwargs or not isinstance(tools, (list, tuple)) or any(not isinstance(tool, CapabilityTool) for tool in tools):
            raise GalaxieError('unsupported')
        names = [tool.name for tool in tools]
        if len(set(names)) != len(names):
            raise GalaxieError('invalid')
        if tool_choice is not None and (not isinstance(tool_choice, str) or tool_choice not in ['auto', 'none', 'required', *names]):
            raise GalaxieError('unsupported')
        choice = ({'type': 'function', 'function': {'name': tool_choice}}
                  if tool_choice in names else tool_choice)
        return self.model_copy(update={'declarations': [{
            'type': 'function', 'function': {'name': tool.name, 'description': tool.description,
                                           'parameters': tool.args_schema},
        } for tool in tools], 'choice': choice})

    def _payload(self, messages, stop):
        if not self.declarations:
            return super()._payload(messages, stop)
        converted = []
        pending = set()
        roles = {'human': 'user', 'ai': 'assistant', 'system': 'system'}
        for message in messages:
            if not isinstance(message.content, str):
                raise GalaxieError('unsupported')
            if isinstance(message, ToolMessage):
                if message.artifact is not None or message.status != 'success':
                    raise GalaxieError('unsupported')
                if message.tool_call_id not in pending:
                    raise GalaxieError('invalid')
                pending.remove(message.tool_call_id)
                converted.append({'role': 'tool', 'content': message.content,
                                  'tool_call_id': message.tool_call_id})
                continue
            role = roles.get(message.type)
            if role is None:
                raise GalaxieError('unsupported')
            item: dict[str, Any] = {'role': role, 'content': message.content}
            if isinstance(message, AIMessage) and message.tool_calls:
                calls = message.tool_calls
                self._validate_calls(calls)
                pending.update(call['id'] for call in calls)
                item['toolCalls'] = [{'id': call['id'], 'type': 'function', 'function': {
                    'name': call['name'], 'arguments': json.dumps(call['args'], separators=(',', ':'), allow_nan=False),
                }} for call in calls]
            converted.append(item)
        options: dict[str, Any] = {'tools': self.declarations}
        if stop is not None:
            options['stop'] = stop
        if self.choice is not None:
            options['toolChoice'] = self.choice
        return {'role': self.role, 'messages': converted, 'options': options}

    def _validate_calls(self, calls):
        names = {tool['function']['name'] for tool in self.declarations}
        ids = set()
        for call in calls:
            if (not isinstance(call.get('id'), str) or not call['id'] or call['id'] in ids
                or call.get('name') not in names or not isinstance(call.get('args'), dict)):
                raise GalaxieError('invalid')
            ids.add(call['id'])

    def decode(self, reply):
        if not isinstance(reply, dict) or not set(reply) <= {'content', 'usage', 'toolCalls'}:
            raise GalaxieError('invalid')
        plain = self._message({key: value for key, value in reply.items() if key != 'toolCalls'})
        calls = []
        try:
            for call in reply.get('toolCalls', []):
                calls.append({'id': call['id'], 'name': call['function']['name'],
                              'args': json.loads(call['function']['arguments']), 'type': 'tool_call'})
        except (ValueError, TypeError, KeyError):
            raise GalaxieError('invalid') from None
        self._validate_calls(calls)
        return AIMessage(content=plain.content, usage_metadata=plain.usage_metadata, tool_calls=calls)

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        reply = await request('model', self._payload(messages, stop))
        return ChatResult(generations=[ChatGeneration(message=self.decode(reply))])

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        raise GalaxieError('unsupported')
        yield  # An async generator with no unmeasured streaming implementation.
