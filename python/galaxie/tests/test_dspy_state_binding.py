# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

import asyncio
import json
from pathlib import Path

import dspy
import pytest

from galaxie import GalaxieError
from galaxie.dspy import Executor, prepare_executor, request_interaction, state_binding


DIGEST = '74da0b98ec28d64cfd32850bb09ef53fcf2adcddc8930eaef4b2dad586bfd040'
INTERACTION = {'surfaceId': 'main', 'viewRevision': 'review', 'component': 'test.Review/v1', 'props': {'stateBinding': 'author'}}


class Program(dspy.Module):
    async def aforward(self, **inputs):
        return dspy.Prediction(answer=request_interaction(INTERACTION))


def paused(binding=None):
    executor = prepare_executor(Program(), state_binding=binding)
    asyncio.run(executor.run({'stateBinding': 'input'}, 'c', 5))
    return executor


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()


def accepts_metadata_3731271(meta):
    return set(meta) == {'v', 'dspy', 'adapter', 'session'} and meta['v'] == 1


def test_manifest_vector_and_creation_order(tmp_path):
    for root, files in [(tmp_path / 'one', [('a.json', b'{}'), ('dir/b.json', b'[]')]),
                        (tmp_path / 'two', [('dir/b.json', b'[]'), ('a.json', b'{}')])]:
        for name, content in files:
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        assert state_binding(root) == DIGEST


def test_manifest_scope_and_empty_roots(tmp_path):
    assert state_binding(tmp_path / 'missing') is None
    assert state_binding(tmp_path) is None
    source = tmp_path / 'agent.py'
    source.write_text('# original\n')
    assert state_binding(source) is None
    state = tmp_path / 'state.json'
    state.write_bytes(b'{}')
    original = state_binding(tmp_path)
    source.write_text('# changed\n')
    cache = tmp_path / '__pycache__'
    cache.mkdir()
    (cache / 'x.json').write_bytes(b'[]')
    assert state_binding(tmp_path) == original
    state.write_bytes(b'{ }')
    assert state_binding(tmp_path) != original
    state.write_bytes(b'{}')
    renamed = state.rename(tmp_path / 'renamed.json')
    assert state_binding(tmp_path) != original
    renamed.rename(state)
    (tmp_path / 'extra.json').write_bytes(b'{}')
    assert state_binding(tmp_path) != original


def test_unreadable_json_refuses_instead_of_partial_binding(tmp_path, monkeypatch):
    path = tmp_path / 'state.json'
    path.write_bytes(b'{}')
    def unreadable(self):
        raise PermissionError('private file path')
    monkeypatch.setattr(Path, 'read_bytes', unreadable)
    with pytest.raises(GalaxieError) as error:
        state_binding(tmp_path)
    assert error.value.code == 'unsupported'
    assert 'private' not in str(error.value)


def test_many_small_json_files(tmp_path):
    for index in range(200):
        (tmp_path / f'{index}.json').write_bytes(b'{}')
    binding = state_binding(tmp_path)
    assert binding is not None and len(binding) == 64


def test_paused_metadata_has_one_fixed_size_key_and_old_code_refuses_it():
    unbound, bound = paused(), paused(DIGEST)
    checkpoint, metadata = unbound._snapshot('c', 'session')
    bound_checkpoint, bound_metadata = bound._snapshot('c', 'session')
    base = {'v': 1, 'dspy': dspy.__version__, 'adapter': 'ChatAdapter', 'session': 'session'}
    assert metadata == encode(base)
    assert bound_checkpoint == checkpoint
    assert json.loads(bound_metadata) == {**base, 'stateBinding': DIGEST}
    assert len(bound_metadata) - len(metadata) == 82
    assert accepts_metadata_3731271(base)
    assert not accepts_metadata_3731271(json.loads(bound_metadata))
    assert json.loads(checkpoint)['input']['stateBinding'] == 'input'
    assert json.loads(checkpoint)['journal'][-1]['request']['props']['stateBinding'] == 'author'
    assert set(json.loads(bound_metadata)) == set(base) | {'stateBinding'}


@pytest.mark.parametrize('binding', [None, DIGEST])
def test_equal_and_legacy_metadata_restore(binding):
    original = paused(binding)
    restored = prepare_executor(Executor(Program()), state_binding=DIGEST)
    assert restored._restore(*original._snapshot('c', 'session'), 'session') == 'c'
    assert restored.pending('c') == original.pending('c')


@pytest.mark.parametrize('binding', ['', 'invalid', DIGEST.upper(), DIGEST[:-1], DIGEST + '0', 7])
def test_invalid_preparation_binding_cannot_publish_or_replace_a_bound_session(binding):
    executor = paused(DIGEST)
    before = executor._snapshot('c', 'session')
    for value in [Program(), executor]:
        with pytest.raises(GalaxieError) as error:
            prepare_executor(value, state_binding=binding)
        assert error.value.code == 'unsupported'
    assert executor._snapshot('c', 'session') == before


@pytest.mark.parametrize('mutation', ['wrong', 'uppercase', 'short', 'long', 'number', 'null', 'completed', 'unrecoverable', 'no-manifest', 'extra'])
def test_invalid_binding_never_replaces_or_registers_a_session(mutation):
    checkpoint, metadata = paused(DIGEST)._snapshot('c', 'session')
    raw, meta = json.loads(checkpoint), json.loads(metadata)
    values = {'wrong': '0' * 64, 'uppercase': DIGEST.upper(), 'short': DIGEST[:-1],
              'long': DIGEST + '0', 'number': 7, 'null': None}
    if mutation in values:
        meta['stateBinding'] = values[mutation]
    if mutation in {'completed', 'unrecoverable'}:
        raw.update(status=mutation, input=None, journal=[])
    if mutation == 'extra':
        meta['unknown'] = True
    for executor in [paused(DIGEST), prepare_executor(Program(), state_binding=DIGEST)]:
        if mutation == 'no-manifest':
            executor = prepare_executor(executor)
        before = dict(executor._sessions)
        with pytest.raises(GalaxieError) as error:
            executor._restore(encode(raw), encode(meta), 'session')
        assert error.value.code == 'unrecoverable'
        assert str(error.value) == 'Stored state cannot be recovered.'
        assert executor._sessions == before
        assert all(executor._sessions[key] is value for key, value in before.items())


def test_completed_and_unrecoverable_metadata_stays_unbound():
    for binding in [None, DIGEST]:
        executor = paused(binding)
        pending = executor.pending('c')
        assert pending is not None
        asyncio.run(executor.run(None, 'c', 5, resume={'interactionId': pending['id'], 'action': 'continue', 'payload': {}}))
        checkpoint, metadata = executor._snapshot('c', 'session', compact=True)
        assert json.loads(checkpoint)['status'] == 'completed'
        assert 'stateBinding' not in json.loads(metadata)
        executor._sessions['c'].unrecoverable = True
        executor._sessions['c'].journal = []
        executor._sessions['c'].value = None
        checkpoint, failed_metadata = executor._snapshot('c', 'session')
        assert json.loads(checkpoint)['status'] == 'unrecoverable'
        assert failed_metadata == metadata
