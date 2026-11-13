// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/**
 * Names the modules whose import loads ADK's lazy dependency chain, so a missing wheel fails at
 * boot with a fixed `unavailable` error instead of at the first run (ADR-0022 decision 4).
 */
export const adkImportProbe: string = `
import galaxie
from google.adk.agents import LlmAgent
from google.adk.runners import Runner
import fastapi.openapi.models
import authlib.integrations.requests_client
import opentelemetry._logs
import opentelemetry.semconv
`;

/**
 * The ADK Python run loop. It builds the executor from the agent's entry factory and runs one
 * conversation per call, streaming checked text deltas and content-free step markers; the model,
 * the tools and the budget all go through the bridge. A pause (a confirmation or a long-running
 * tool) ends the run with the interaction pending in the executor, and the answer resumes it as a
 * new run. With checkpoints on, each galaxie session maps to one random conversation ID, the
 * executor's session record is stored through the byte-record port after every successful run,
 * and it is restored and verified before every run or pending read (ADR-0022 decision 13).
 */
export const adkDriver: string = `
import sys, json, asyncio, importlib, uuid, base64
from datetime import datetime, timezone
from galaxie._bridge import install_transport, GalaxieError, receive_model_chunk, notify_stream_data, request
from _galaxie_transport import request as _transport, notify as _notify
from galaxie.adk import prepare_executor, quiet, CHECKPOINT_TYPE, STATE_TYPE, _declare_roles
sys.path.insert(0, '/agent')
async def _galaxie_request(raw):
    return await _transport(raw)
install_transport(_galaxie_request, _notify)
_galaxie_conversations = {}
_galaxie_revisions = {}
try:
    with quiet():
        _declare_roles(json.loads(_galaxie_roles))
        _galaxie_executor = prepare_executor(getattr(importlib.import_module(_galaxie_module), _galaxie_entry)())
    if _galaxie_durable:
        _galaxie_executor.durable = True
    _galaxie_ready = {'ok': True}
except GalaxieError as error:
    _galaxie_ready = {'ok': False, 'code': error.code}
except Exception:
    _galaxie_ready = {'ok': False, 'code': 'unavailable'}
async def _galaxie_load(session):
    if not _galaxie_durable:
        return session
    saved = await request('checkpoint', {'op': 'get', 'sessionId': session, 'namespace': ''})
    if saved is None:
        # A record that was stored and is now gone (a sweep or a delete) must not come back from
        # memory. A run that never stored one keeps its conversation ID, so a retry reuses its effects.
        if _galaxie_revisions.pop(session, None) is not None:
            known = _galaxie_conversations.pop(session, None)
            if known is not None:
                _galaxie_executor.forget(known)
        return _galaxie_conversations.get(session)
    try:
        if (saved['checkpoint']['type'] != CHECKPOINT_TYPE or saved['metadata']['type'] != STATE_TYPE
            or len(saved['id']) != 20 or not saved['id'].isascii() or not saved['id'].isdigit()
            or int(saved['id']) < 1):
            raise ValueError()
        conversation = await _galaxie_executor._restore(
            base64.b64decode(saved['checkpoint']['bytes'], validate=True),
            base64.b64decode(saved['metadata']['bytes'], validate=True),
            session,
            [known for owner, known in _galaxie_conversations.items() if owner != session],
        )
    except Exception:
        raise GalaxieError('unrecoverable') from None
    _galaxie_conversations[session] = conversation
    _galaxie_revisions[session] = int(saved['id'])
    return conversation
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
        'checkpoint': _galaxie_bytes(CHECKPOINT_TYPE, checkpoint),
        'metadata': _galaxie_bytes(STATE_TYPE, metadata),
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
        conversation = await _galaxie_load(session)
        if conversation is None:
            conversation = _galaxie_conversations[session] = str(uuid.uuid4())
        output = await _galaxie_executor.run(
            payload.get('input'), conversation, payload['steps'],
            on_stream=lambda mode, data: notify_stream_data([], mode, data),
            resume=payload.get('resume'),
        )
        try:
            await _galaxie_save(session, conversation)
        except BaseException:
            # The store did not take the new state, so memory must not run ahead of it.
            _galaxie_executor.forget(conversation)
            raise
        if _galaxie_executor.pending(conversation) is not None:
            return json.dumps({'ok': True, 'interrupted': True})
        return json.dumps({'ok': True, 'output': output}, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    except GalaxieError as error:
        return json.dumps({'ok': False, 'code': error.code})
    except asyncio.CancelledError:
        return json.dumps({'ok': False, 'code': 'cancelled'})
    except Exception:
        return json.dumps({'ok': False, 'code': 'executor_error'})
`;
