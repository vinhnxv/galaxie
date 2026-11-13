// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

export const dspyDriver: string = `
import sys, os, json, asyncio, importlib, uuid, base64
from datetime import datetime, timezone
os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] = 'true'
import dspy
from galaxie._bridge import install_transport, GalaxieError, receive_model_chunk, notify_stream_data, request, MAX_BYTES
from galaxie.dspy import prepare_executor, error_code, state_binding
from _galaxie_transport import request as _transport, notify as _notify
sys.path.insert(0, '/agent')
async def _galaxie_request(raw):
    return await _transport(raw)
install_transport(_galaxie_request, _notify)
dspy.configure_cache(enable_disk_cache=False, enable_memory_cache=False)
_galaxie_conversations = {}
_galaxie_revisions = {}
_galaxie_state_root = globals().get('_galaxie_state_root', '/agent')
try:
    _galaxie_binding = state_binding(_galaxie_state_root) if _galaxie_durable else None
    _galaxie_executor = prepare_executor(getattr(importlib.import_module(_galaxie_module), _galaxie_entry)(), state_binding=_galaxie_binding)
    _galaxie_ready = {'ok': True}
except BaseException as error:
    _galaxie_ready = {'ok': False, 'code': error_code(error)}
async def _galaxie_load(session):
    if _galaxie_durable:
        saved = await request('checkpoint', {'op': 'get', 'sessionId': session, 'namespace': ''})
        if saved is None:
            _galaxie_revisions.pop(session, None)
            _galaxie_conversations.pop(session, None)
            return None
        try:
            if (saved['checkpoint']['type'] != 'dspy.journal/v1'
                or saved['metadata']['type'] != 'galaxie.dspy-state/v1'
                or len(saved['id']) != 20 or not saved['id'].isascii() or not saved['id'].isdigit()
                or int(saved['id']) < 1):
                raise ValueError()
            checkpoint = base64.b64decode(saved['checkpoint']['bytes'], validate=True)
            identifier = json.loads(checkpoint)['conversation_id']
            if any(known == identifier and owner != session for owner, known in _galaxie_conversations.items()):
                raise ValueError()
            conversation = _galaxie_executor._restore(
                checkpoint,
                base64.b64decode(saved['metadata']['bytes'], validate=True), session,
            )
        except BaseException:
            raise GalaxieError('unrecoverable') from None
        _galaxie_conversations[session] = conversation
        _galaxie_revisions[session] = int(saved['id'])
    return _galaxie_conversations.get(session)
def _galaxie_bytes(kind, value):
    return {'type': kind, 'bytes': base64.b64encode(value).decode('ascii')}
async def _galaxie_save(session, conversation):
    if not _galaxie_durable:
        return
    pending = None if _galaxie_executor._sessions[conversation].unrecoverable else _galaxie_executor.pending(conversation)
    # Only a pause needs its journal; completion keeps counters so an old pause cannot resurrect or reuse write scopes.
    checkpoint, metadata = _galaxie_executor._snapshot(conversation, session, compact=pending is None)
    previous = _galaxie_revisions.get(session, 0)
    identifier = f'{previous + 1:020d}'
    location = {'sessionId': session, 'namespace': '', 'id': identifier}
    record = {'op': 'put', **location,
        'parentId': f'{previous:020d}' if previous else None,
        'checkpoint': _galaxie_bytes('dspy.journal/v1', checkpoint),
        'metadata': _galaxie_bytes('galaxie.dspy-state/v1', metadata),
        'timestamp': datetime.now(timezone.utc).isoformat(),
    }
    if len(json.dumps(record, ensure_ascii=False).encode('utf-8')) + 4096 > MAX_BYTES:
        raise GalaxieError('unsupported')
    # The checkpoint is the commit marker; replace any orphan marker before committing it.
    await request('checkpoint', {'op': 'put-writes', **location, 'taskId': 'conversation', 'taskPath': '', 'writes': [{
        'channel': '__interrupt__', 'index': -3, 'interruptIds': [pending['id']] if pending else [],
        'value': _galaxie_bytes('json', json.dumps({'id': pending['id']} if pending else None).encode()),
    }]})
    await request('checkpoint', record)
    _galaxie_revisions[session] = previous + 1
async def _galaxie_pending():
    try:
        conversation = await _galaxie_load(_galaxie_thread)
        pending = _galaxie_executor.pending(conversation) if conversation else None
        return json.dumps({'ok': True, 'interrupts': [pending] if pending else []})
    except BaseException as error:
        return json.dumps({'ok': False, 'code': error_code(error)})
async def _galaxie_execute():
    global _galaxie_task
    _galaxie_task = asyncio.current_task()
    already_poisoned = False
    try:
        payload = json.loads(_galaxie_input)
        session = payload['threadId']
        conversation = await _galaxie_load(session)
        if conversation is None:
            _galaxie_conversations[session] = str(uuid.uuid4())
        else:
            known = _galaxie_executor._sessions.get(conversation)
            already_poisoned = known is not None and known.unrecoverable
        output = await _galaxie_executor.run(
            payload.get('input'), _galaxie_conversations[session], payload['steps'],
            on_stream=lambda mode, data: notify_stream_data([], mode, data),
            resume=payload.get('resume'),
        )
        await _galaxie_save(session, _galaxie_conversations[session])
        if _galaxie_executor.pending(_galaxie_conversations[session]) is not None:
            return json.dumps({'ok': True, 'interrupted': True})
        state = _galaxie_executor._sessions[_galaxie_conversations[session]]
        state.journal = []
        state.value = None
        return json.dumps({'ok': True, 'output': output}, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    except BaseException as error:
        if not already_poisoned and error_code(error) == 'unrecoverable' and 'session' in locals() and session in _galaxie_conversations:
            try:
                # A poison marker prevents a later restore from retrying a divergent program.
                conversation = _galaxie_conversations[session]
                if _galaxie_executor._sessions[conversation].unrecoverable:
                    await _galaxie_save(session, conversation)
            except BaseException:
                pass
        return json.dumps({'ok': False, 'code': error_code(error)})
`;
