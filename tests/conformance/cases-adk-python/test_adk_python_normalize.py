# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
from typing import Any

import pytest

spec = importlib.util.spec_from_file_location('adk_python_normalize_native', Path(__file__).with_name('native.py'))
if spec is None or spec.loader is None:
    raise ImportError('The conformance module cannot be loaded.')
native = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = native
spec.loader.exec_module(native)


def history(agent, *ids):
    messages: list[dict[str, Any]] = [{'role': 'user', 'content': 'question'}]
    requests = [{'agent': agent, 'messages': deepcopy(messages)}]
    for identifier in ids:
        messages.extend([
            {'role': 'assistant', 'tool_calls': [{'id': identifier}]},
            {'role': 'tool', 'tool_call_id': identifier},
        ])
        requests.append({'agent': agent, 'messages': deepcopy(messages)})
    return requests


def test_single_call_histories_keep_existing_per_request_labels():
    requests = history('left', 'left-raw') + history('right', 'right-raw')
    per_agent = deepcopy(requests)
    for request in requests:
        native.renumber([request])
    assert requests == history('left', 'call-1') + history('right', 'call-1')
    native.renumber_per_agent(per_agent)
    assert per_agent == requests


def test_two_calls_retain_labels_across_requests_and_agents_number_independently():
    requests = history('left', 'raw-a', 'raw-b') + history('right', 'raw-a', 'raw-b')
    native.assert_call_consistency(requests)
    native.renumber_per_agent(requests)
    assert requests == history('left', 'call-1', 'call-2') + history('right', 'call-1', 'call-2')


@pytest.mark.parametrize('messages', [
    [{'role': 'tool', 'tool_call_id': 'dangling'}],
    [{'role': 'assistant', 'tool_calls': [{'id': 'duplicate'}, {'id': 'duplicate'}]}],
    [
        {'role': 'assistant', 'tool_calls': [{'id': 'answered'}]},
        {'role': 'tool', 'tool_call_id': 'answered'},
        {'role': 'tool', 'tool_call_id': 'answered'},
    ],
])
def test_inconsistent_raw_call_history_is_refused(messages):
    with pytest.raises(ValueError):
        native.assert_call_consistency([{'agent': 'left', 'messages': messages}])


def test_consistently_changed_call_id_fails_prefix_check_between_requests():
    requests = history('left', 'old', 'next')
    requests[-1]['messages'] = history('left', 'changed', 'next')[-1]['messages']
    with pytest.raises(ValueError):
        native.assert_call_consistency(requests)


def test_order_assertions_use_arrival_labels_and_require_both_ends():
    order = [('left#2:response', 'merger#1:request')]
    native.assert_order(['left#2:response', 'merger#1:request'], order)
    with pytest.raises(ValueError):
        native.assert_order(['merger#1:request', 'left#2:response'], order)
    with pytest.raises(ValueError):
        native.assert_order(['left#2:response'], order)
