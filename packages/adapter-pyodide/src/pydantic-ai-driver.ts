// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export const pydanticAiDriver: string = `
import sys, json, asyncio, importlib, uuid
from galaxie._bridge import install_transport, GalaxieError, receive_model_chunk, notify_stream
from _galaxie_transport import request as _transport, notify as _notify
from pydantic_ai import Agent
from galaxie.pydantic_ai import prepare_executor
sys.path.insert(0, '/agent')
async def _galaxie_request(raw):
    return await _transport(raw)
install_transport(_galaxie_request, _notify)
Agent.instrument_all(False)
_galaxie_conversations = {}
try:
    if _galaxie_durable:
        raise GalaxieError('unsupported')
    _galaxie_executor = prepare_executor(getattr(importlib.import_module(_galaxie_module), _galaxie_entry)())
    _galaxie_ready = {'ok': True}
except GalaxieError as error:
    _galaxie_ready = {'ok': False, 'code': error.code}
except Exception:
    _galaxie_ready = {'ok': False, 'code': 'unavailable'}
async def _galaxie_pending():
    return json.dumps({'ok': True, 'interrupts': []})
async def _galaxie_execute():
    global _galaxie_task
    _galaxie_task = asyncio.current_task()
    try:
        payload = json.loads(_galaxie_input)
        if 'resume' in payload:
            raise GalaxieError('unsupported')
        session = payload['threadId']
        if session not in _galaxie_conversations:
            _galaxie_conversations[session] = str(uuid.uuid4())
        output = await _galaxie_executor.run(
            payload['input'], _galaxie_conversations[session], payload['steps'],
            on_stream=lambda mode, data: notify_stream([], mode, data),
        )
        return json.dumps({'ok': True, 'output': output}, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    except GalaxieError as error:
        return json.dumps({'ok': False, 'code': error.code})
    except asyncio.CancelledError:
        return json.dumps({'ok': False, 'code': 'cancelled'})
    except Exception:
        return json.dumps({'ok': False, 'code': 'executor_error'})
`;
