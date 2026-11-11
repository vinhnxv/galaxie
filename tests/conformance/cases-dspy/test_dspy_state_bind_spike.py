# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Keep the uninstalled spike's descriptor and Module.load scope comparison."""

import json

from dspy.primitives.base_module import BaseModule
from galaxie.dspy import state_binding

from test_dspy_state_durable import load_module, programs
from test_dspy_state_bind import root_for

candidate = load_module('state_bind_candidate', 'state_bind_candidate.py')


def test_descriptor_scope_and_module_load_comparison(tmp_path):
    root = root_for(tmp_path, 'pause', 'same')
    source = root / 'selected.py'
    source.write_text('# original\n')
    assert state_binding(root) == candidate.descriptor_digest(root)
    state, all_files = candidate.descriptor_digest(root), candidate.descriptor_digest(root, 'all')
    source.write_text('# comment-only edit\n')
    assert candidate.descriptor_digest(root) == state
    assert candidate.descriptor_digest(root, 'all') != all_files
    for scope in ('state', 'all'):
        before = candidate.descriptor_digest(root, scope)
        path = root / 'state.json'
        path.write_bytes(path.read_bytes() + b'\n')
        assert candidate.descriptor_digest(root, scope) != before
        before = candidate.descriptor_digest(root, scope)
        path.rename(root / 'renamed.json')
        assert candidate.descriptor_digest(root, scope) != before
        (root / 'renamed.json').rename(path)
        before = candidate.descriptor_digest(root, scope)
        (root / 'extra.json').write_text('{}')
        assert candidate.descriptor_digest(root, scope) != before
        (root / 'extra.json').unlink()
        before = candidate.descriptor_digest(root, scope)
        cache = root / '__pycache__'
        cache.mkdir(exist_ok=True)
        (cache / 'x.json').write_text('ignored')
        assert candidate.descriptor_digest(root, scope) == before
    files = {'b.json': b'{}', 'a.json': b'[]'}
    assert candidate.manifest_digest(files) == candidate.manifest_digest(dict(reversed(list(files.items()))))
    original = BaseModule.load
    with candidate.loaded_files(root) as loaded:
        executor = programs.factory('state-durable-late-model', root / 'state.json')
        assert candidate.manifest_digest(loaded) == candidate.descriptor_digest(root)
    assert BaseModule.load is original
    with candidate.loaded_files(root) as loaded:
        executor.module.predict.load_state(json.loads((root / 'state.json').read_text()))
        assert candidate.manifest_digest(loaded) is None
        assert candidate.descriptor_digest(root) is not None
    assert BaseModule.load is original


