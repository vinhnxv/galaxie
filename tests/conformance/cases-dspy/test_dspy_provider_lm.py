# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Measure the five refusal programs through the native Worker-driver twin."""

import json
from pathlib import Path

import pytest

from test_dspy_provider import Store

CASES = json.loads(Path(__file__).with_name('provider-lm-golden-cases.json').read_text())


@pytest.mark.parametrize('name', CASES)
def test_native_runtime_provider_lm_refusal(name):
    store = Store()
    context = store.boot(name)
    assert store.execute(context) == {'ok': False, 'code': 'unsupported'}
    assert (store.requests, store.capability_requests, store.orphans, store.after_termination) == (0, 0, 0, 0)
    evidence, = [event for event in store.events if event.get('kind') == 'provider-egress']
    assert evidence == {'kind': 'provider-egress', 'attempts': [], 'recorder': True, 'unexpected': False}
