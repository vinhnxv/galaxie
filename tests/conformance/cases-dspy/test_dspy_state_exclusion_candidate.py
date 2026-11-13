# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Measure an explicit exclusion-list candidate without changing the shipped binding."""

import asyncio
import base64
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re

import galaxie.dspy as galaxie_dspy
from galaxie._bridge import GalaxieError
import pytest

from test_dspy_state_durable import Store, checkpoint, native, state_file

SHIPPED_BINDING = galaxie_dspy.state_binding


def exclusion_binding(root, exclusions):
    """Test-only digest envelope; empty exclusions preserve the shipped bytes."""
    if type(exclusions) is not list or len(exclusions) > 16:
        raise GalaxieError('unsupported')
    for name in exclusions:
        if (type(name) is not str or not name or '\\' in name
            or any(character in name for character in '*?[]')
            or PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts
            or PurePosixPath(name).as_posix() != name or PurePosixPath(name).suffix != '.json'):
            raise GalaxieError('unsupported')
    if exclusions != sorted(set(exclusions)):
        raise GalaxieError('unsupported')
    if not exclusions:
        return SHIPPED_BINDING(root)

    root = Path(root)

    def fail(error):
        raise error

    try:
        files = {
            path.relative_to(root).as_posix(): path
            for directory, names, filenames in (os.walk(root, onerror=fail) if root.is_dir() else ())
            for path in (Path(directory, name) for name in filenames)
            if path.suffix == '.json' and '__pycache__' not in path.relative_to(root).parts
        }
        if not set(exclusions).issubset(files):
            raise GalaxieError('unsupported')
        entries = [[name, hashlib.sha256(path.read_bytes()).hexdigest()]
                   for name, path in sorted(files.items()) if name not in exclusions]
        envelope = {'exclude': exclusions, 'files': entries}
        return hashlib.sha256(json.dumps(envelope, ensure_ascii=False, allow_nan=False,
                                         separators=(',', ':')).encode('utf-8')).hexdigest()
    except (OSError, UnicodeEncodeError):
        raise GalaxieError('unsupported') from None


def install_candidate(monkeypatch, exclusions):
    monkeypatch.setattr(galaxie_dspy, 'state_binding', lambda root: exclusion_binding(root, exclusions))


def descriptor(tmp_path, name='descriptor'):
    root = tmp_path / name
    root.mkdir()
    state_file(root, 'same').rename(root / 'state.json')
    (root / 'unrelated.json').write_text('{}')
    return root


def raw_pending(context):
    context['_galaxie_thread'] = 'session'
    return json.loads(asyncio.run(context['_galaxie_pending']()))


@pytest.mark.parametrize('populated', [False, True])
def test_empty_exclusions_preserve_the_shipped_digest(tmp_path, populated):
    if populated:
        (tmp_path / 'state.json').write_text('{"value": 1}')
        nested = tmp_path / 'nested'
        nested.mkdir()
        (nested / 'other.json').write_text('[]')
    assert exclusion_binding(tmp_path, []) == SHIPPED_BINDING(tmp_path)


def test_excluded_bytes_do_not_change_the_candidate_digest(tmp_path):
    (tmp_path / 'unrelated.json').write_text('{}')
    (tmp_path / 'state.json').write_text('{}')
    before = exclusion_binding(tmp_path, ['unrelated.json'])
    (tmp_path / 'unrelated.json').write_text('["edited"]')
    assert exclusion_binding(tmp_path, ['unrelated.json']) == before


@pytest.mark.parametrize('change', ['edit', 'add', 'remove', 'whitespace'])
def test_every_non_excluded_json_change_changes_the_digest(tmp_path, change):
    (tmp_path / 'unrelated.json').write_text('{}')
    state = tmp_path / 'state.json'
    state.write_text('{}')
    before = exclusion_binding(tmp_path, ['unrelated.json'])
    if change == 'edit':
        state.write_text('[]')
    elif change == 'add':
        (tmp_path / 'added.json').write_text('{}')
    elif change == 'remove':
        state.unlink()
    else:
        state.write_text('{ }\n')
    assert exclusion_binding(tmp_path, ['unrelated.json']) != before


def test_adding_removing_or_replacing_an_exclusion_changes_the_digest(tmp_path):
    for name in ['a.json', 'b.json', 'c.json']:
        (tmp_path / name).write_text('{}')
    lists = [[], ['a.json'], ['a.json', 'b.json'], ['a.json', 'b.json', 'c.json'], ['a.json', 'c.json']]
    assert len({exclusion_binding(tmp_path, names) for names in lists}) == len(lists)


@pytest.mark.parametrize('invalid', [
    None, 'a.json', [None], [1], [{}], ['/a.json'], ['../a.json'], ['nested/../a.json'],
    ['nested\\a.json'], ['*.json'], ['a?.json'], ['[a].json'], ['a.txt'], [''],
    ['./a.json'], ['a.json', 'a.json'], ['b.json', 'a.json'],
    [f'{index:02d}.json' for index in range(17)],
])
def test_invalid_exclusions_refuse_before_producing_a_binding(tmp_path, invalid):
    (tmp_path / 'a.json').write_text('{}')
    (tmp_path / 'b.json').write_text('{}')
    with pytest.raises(GalaxieError) as caught:
        exclusion_binding(tmp_path, invalid)
    assert caught.value.code == 'unsupported'


def test_a_missing_excluded_descriptor_file_refuses_at_driver_boot(tmp_path, monkeypatch):
    root = descriptor(tmp_path)
    store = Store()
    context = store.boot('state-durable-late-model', root / 'state.json')
    install_candidate(monkeypatch, ['missing.json'])
    context['_galaxie_state_root'] = root
    exec(native.DRIVER, context)
    assert context['_galaxie_ready'] == {'ok': False, 'code': 'unsupported'}
    assert store.rows == {} and store.writes == {} and store.calls == [] and store.requests == 0


@pytest.mark.parametrize('replacement', [[], ['state.json'], ['state.json', 'unrelated.json']])
def test_a_changed_exclusion_list_refuses_an_earlier_pause(tmp_path, monkeypatch, replacement):
    root = descriptor(tmp_path)
    install_candidate(monkeypatch, ['unrelated.json'])
    store = Store()
    context = store.boot('state-durable-late-model', root / 'state.json', bind=root)
    assert native.execute(context) == {'ok': True, 'interrupted': True}
    saved = copy.deepcopy((store.rows, store.writes, store.effects, store.events, store.requests))
    install_candidate(monkeypatch, replacement)
    context = store.boot('state-durable-late-model', root / 'state.json', bind=root)
    assert raw_pending(context) == {'ok': False, 'code': 'unrecoverable'}
    assert (store.rows, store.writes, store.effects, store.events, store.requests) == saved
    assert store.calls == ['before']


@pytest.mark.parametrize('edited', ['unrelated.json', 'other.json'])
def test_candidate_restore_distinguishes_excluded_and_bound_json(tmp_path, monkeypatch, edited):
    root = descriptor(tmp_path)
    (root / 'other.json').write_text('{}')
    install_candidate(monkeypatch, ['unrelated.json'])
    store = Store()
    context = store.boot('state-durable-late-model', root / 'state.json', bind=root)
    assert native.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    assert before is not None
    saved = copy.deepcopy((store.rows, store.writes, store.effects, store.events, store.requests))
    (root / edited).write_text('[]')
    context = store.boot('state-durable-late-model', root / 'state.json', bind=root)
    if edited == 'unrelated.json':
        assert native.pending(context) == before
        assert native.execute(context, before)['ok']
        assert checkpoint(store)['status'] == 'completed' and store.requests == 1
        assert len([event for event in store.events if event.get('kind') == 'replayed']) == 1
    else:
        assert raw_pending(context) == {'ok': False, 'code': 'unrecoverable'}
        assert (store.rows, store.writes, store.effects, store.events, store.requests) == saved
    assert store.calls == ['before']


def test_candidate_keeps_the_existing_paused_metadata_envelope(tmp_path, monkeypatch):
    root = descriptor(tmp_path)
    install_candidate(monkeypatch, ['unrelated.json'])
    store = Store()
    context = store.boot('state-durable-late-model', root / 'state.json', bind=root)
    assert native.execute(context) == {'ok': True, 'interrupted': True}
    row = list(store.rows.values())[-1]
    metadata = json.loads(base64.b64decode(row['metadata']['bytes']))
    assert set(metadata) == {'v', 'dspy', 'adapter', 'session', 'stateBinding'}
    assert metadata['v'] == 1
    assert re.fullmatch('[0-9a-f]{64}', metadata['stateBinding']) is not None
    assert metadata['stateBinding'] == exclusion_binding(root, ['unrelated.json'])


@pytest.mark.parametrize('binding', ['shipped', 'candidate'])
def test_excluding_a_loaded_dspy_state_file_allows_an_undetected_swap(tmp_path, monkeypatch, binding):
    root = descriptor(tmp_path)
    if binding == 'candidate':
        install_candidate(monkeypatch, ['state.json'])
    store = Store()
    context = store.boot('state-durable-late-model', root / 'state.json', bind=root)
    assert native.execute(context) == {'ok': True, 'interrupted': True}
    before = native.pending(context)
    assert before is not None
    saved = copy.deepcopy((store.rows, store.writes, store.effects, store.events, store.requests))
    replacement = state_file(tmp_path, 'prompt')
    (root / 'state.json').write_bytes(replacement.read_bytes())
    context = store.boot('state-durable-late-model', root / 'state.json', bind=root)
    if binding == 'candidate':
        assert native.pending(context) == before
        result = native.execute(context, before)
        changed = json.loads(replacement.read_bytes())
        assert result == {'ok': True, 'output': {'answer': 'done', 'receipt': native.durable.PRIVATE_RESULT,
                                               'demos': len(changed['demos']),
                                               'instructions': changed['signature']['instructions']}}
        assert checkpoint(store)['status'] == 'completed' and store.requests == 1
        assert len([event for event in store.events if event.get('kind') == 'replayed']) == 1
    else:
        assert raw_pending(context) == {'ok': False, 'code': 'unrecoverable'}
        assert (store.rows, store.writes, store.effects, store.events, store.requests) == saved
    assert store.calls == ['before']
