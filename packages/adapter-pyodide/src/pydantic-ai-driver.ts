// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: AGPL-3.0-only

export const pydanticAiDriver: string = `
import sys, json, asyncio, importlib, uuid, base64
from datetime import datetime, timezone
from galaxie._bridge import install_transport, GalaxieError, receive_model_chunk, notify_stream, request
from _galaxie_transport import request as _transport, notify as _notify
from pydantic_ai import Agent
from galaxie.pydantic_ai import prepare_executor
sys.path.insert(0, '/agent')
async def _galaxie_request(raw):
    return await _transport(raw)
install_transport(_galaxie_request, _notify)
Agent.instrument_all(False)
_galaxie_conversations = {}
_galaxie_revisions = {}
try:
    _galaxie_executor = prepare_executor(getattr(importlib.import_module(_galaxie_module), _galaxie_entry)())
    _galaxie_ready = {'ok': True}
except GalaxieError as error:
    _galaxie_ready = {'ok': False, 'code': error.code}
except Exception:
    _galaxie_ready = {'ok': False, 'code': 'unavailable'}
async def _galaxie_load(session):
    if _galaxie_durable:
        saved = await request('checkpoint', {'op': 'get', 'sessionId': session, 'namespace': ''})
        if saved is None:
            _galaxie_revisions.pop(session, None)
            return None
        try:
            if (saved['checkpoint']['type'] != 'pydantic-ai.conversation/2.60.0'
                or saved['metadata']['type'] != 'galaxie.pydantic-ai-state/v1'
                or len(saved['id']) != 20 or not saved['id'].isascii() or not saved['id'].isdigit()
                or int(saved['id']) < 1):
                raise ValueError()
            conversation = _galaxie_executor._restore(
                base64.b64decode(saved['checkpoint']['bytes'], validate=True),
                base64.b64decode(saved['metadata']['bytes'], validate=True),
                session,
            )
            if any(known == conversation and owner != session for owner, known in _galaxie_conversations.items()):
                raise ValueError()
        except Exception:
            raise GalaxieError('unrecoverable') from None
        _galaxie_conversations[session] = conversation
        _galaxie_revisions[session] = int(saved['id'])
    return _galaxie_conversations.get(session)
def _galaxie_bytes(kind, value):
    return {'type': kind, 'bytes': base64.b64encode(value).decode('ascii')}
async def _galaxie_save(session, conversation):
    if not _galaxie_durable:
        return
    checkpoint, metadata = _galaxie_executor._snapshot(conversation, session)
    previous = _galaxie_revisions.get(session, 0)
    identifier = f'{previous + 1:020d}'
    location = {'sessionId': session, 'namespace': '', 'id': identifier}
    pending = _galaxie_executor.pending(conversation)
    # The checkpoint is the commit marker. Clear an orphan interrupt if a failed put reused this ID.
    await request('checkpoint', {'op': 'put-writes', **location, 'taskId': 'conversation', 'taskPath': '', 'writes': [{
        'channel': '__interrupt__', 'index': -3, 'interruptIds': [pending['id']] if pending else [],
        'value': _galaxie_bytes('json', json.dumps(pending, ensure_ascii=False, allow_nan=False).encode()),
    }]})
    await request('checkpoint', {'op': 'put', **location,
        'parentId': f'{previous:020d}' if previous else None,
        'checkpoint': _galaxie_bytes('pydantic-ai.conversation/2.60.0', checkpoint),
        'metadata': _galaxie_bytes('galaxie.pydantic-ai-state/v1', metadata),
        'timestamp': datetime.now(timezone.utc).isoformat(),
    })
    _galaxie_revisions[session] = previous + 1
async def _galaxie_pending():
    try:
        conversation = await _galaxie_load(_galaxie_thread)
        pending = _galaxie_executor.pending(conversation) if conversation else None
        return json.dumps({'ok': True, 'interrupts': [pending] if pending else []})
    except GalaxieError as error:
        return json.dumps({'ok': False, 'code': error.code})
    except Exception:
        return json.dumps({'ok': False, 'code': 'executor_error'})
async def _galaxie_execute():
    global _galaxie_task
    _galaxie_task = asyncio.current_task()
    try:
        payload = json.loads(_galaxie_input)
        session = payload['threadId']
        if await _galaxie_load(session) is None:
            _galaxie_conversations[session] = str(uuid.uuid4())
        output = await _galaxie_executor.run(
            payload.get('input'), _galaxie_conversations[session], payload['steps'],
            on_stream=lambda mode, data: notify_stream([], mode, data),
            resume=payload.get('resume'),
        )
        await _galaxie_save(session, _galaxie_conversations[session])
        if _galaxie_executor.pending(_galaxie_conversations[session]) is not None:
            return json.dumps({'ok': True, 'interrupted': True})
        return json.dumps({'ok': True, 'output': output}, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    except GalaxieError as error:
        return json.dumps({'ok': False, 'code': error.code})
    except asyncio.CancelledError:
        return json.dumps({'ok': False, 'code': 'cancelled'})
    except Exception:
        return json.dumps({'ok': False, 'code': 'executor_error'})
`;
