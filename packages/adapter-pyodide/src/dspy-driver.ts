// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export const dspyDriver: string = `
import sys, os, json, asyncio, importlib, uuid
os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'true'
import dspy
from galaxie._bridge import install_transport, GalaxieError, receive_model_chunk, notify_stream_data
from galaxie.dspy import prepare_executor, error_code
from _galaxie_transport import request as _transport, notify as _notify
sys.path.insert(0, '/agent')
async def _galaxie_request(raw):
    return await _transport(raw)
install_transport(_galaxie_request, _notify)
dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
_galaxie_conversations = {}
try:
    if _galaxie_durable:
        raise GalaxieError('unsupported')
    _galaxie_executor = prepare_executor(getattr(importlib.import_module(_galaxie_module), _galaxie_entry)())
    _galaxie_ready = {'ok': True}
except BaseException as error:
    _galaxie_ready = {'ok': False, 'code': error_code(error)}
async def _galaxie_pending():
    try:
        conversation = _galaxie_conversations.get(_galaxie_thread)
        pending = _galaxie_executor.pending(conversation) if conversation else None
        return json.dumps({'ok': True, 'interrupts': [pending] if pending else []})
    except BaseException as error:
        return json.dumps({'ok': False, 'code': error_code(error)})
async def _galaxie_execute():
    global _galaxie_task
    _galaxie_task = asyncio.current_task()
    try:
        payload = json.loads(_galaxie_input)
        session = payload['threadId']
        if session not in _galaxie_conversations:
            _galaxie_conversations[session] = str(uuid.uuid4())
        output = await _galaxie_executor.run(
            payload.get('input'), _galaxie_conversations[session], payload['steps'],
            on_stream=lambda mode, data: notify_stream_data([], mode, data),
            resume=payload.get('resume'),
        )
        if _galaxie_executor.pending(_galaxie_conversations[session]) is not None:
            return json.dumps({'ok': True, 'interrupted': True})
        return json.dumps({'ok': True, 'output': output}, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    except BaseException as error:
        return json.dumps({'ok': False, 'code': error_code(error)})
`;
