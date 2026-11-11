# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Test-only branch journal; never installed by shipped code."""

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from contextvars import ContextVar
import json
import re
from typing import Any

import galaxie.dspy as face
from galaxie._bridge import GalaxieError

# Outcome rule, fixed before Worker measurements: verbatim parity first, then
# shipped async replacement, then this design against every required criterion.
# An unmeasured criterion fails. Otherwise record refusal, retaining predictions.
WIDTH = 32
KEY = re.compile(r'[A-Za-z0-9_.-]{1,64}', re.ASCII)
MARK = re.compile(r'[A-Za-z0-9_.-]{1,64}/(?:0|[1-9][0-9]{0,4})', re.ASCII)
_branch: ContextVar[str | None] = ContextVar('parallel_spike_branch', default=None)
_group: ContextVar[bool] = ContextVar('parallel_spike_group', default=False)


def fail(run: Any, code: str = 'unsupported') -> Any:
    run.record(code)
    state(run)['ready'].set()
    run.check()


def state(run: Any) -> dict[str, Any]:
    current = getattr(run, '_parallel_spike', None)
    if current is None:
        entries = run.session.journal[:run.replay]
        current = {
            'entries': entries, 'remaining': set(range(run.replay)),
            'index': {entry['branch']: index for index, entry in enumerate(entries) if 'branch' in entry},
            'ordinals': {}, 'ready': asyncio.Event(),
        }
        setattr(run, '_parallel_spike', current)
    return current


def remaining_branches(run: Any) -> set[int]:
    current = state(run)
    return {index for index in current['remaining'] if 'branch' in current['entries'][index]}


def consumed(run: Any, index: int) -> None:
    current = state(run)
    current['remaining'].remove(index)
    run.cursor += 1
    if not remaining_branches(run):
        current['ready'].set()


async def branches(items: Mapping[str, Callable[[], Awaitable[Any]]]) -> dict[str, Any]:
    run = face._run.get()
    if run is None:
        raise GalaxieError('unsupported')
    run.check()
    pairs = list(items.items())
    keys = [key for key, _ in pairs]
    if (_group.get() or run.streaming or len(pairs) > WIDTH or len(set(keys)) != len(keys)
        or any(type(key) is not str or KEY.fullmatch(key) is None or not callable(call) for key, call in pairs)):
        fail(run)
    current = state(run)
    # The next contiguous branch segment belongs to this join. In particular,
    # removing a whole branch must fail before any sibling can go live.
    expected = set()
    for index in sorted(current['remaining']):
        entry = current['entries'][index]
        if 'branch' not in entry:
            break
        expected.add(entry['branch'].rsplit('/', 1)[0])
    if expected and expected != set(keys):
        fail(run, 'unrecoverable')

    async def invoke(key: str, call: Callable[[], Awaitable[Any]]) -> Any:
        token = _branch.set(key)
        try:
            result = await call()
            if any(current['entries'][index].get('branch', '').rsplit('/', 1)[0] == key for index in remaining_branches(run)):
                fail(run, 'unrecoverable')
            return result
        finally:
            _branch.reset(token)

    token = _group.set(True)
    try:
        async with asyncio.TaskGroup() as group:
            tasks = {key: group.create_task(invoke(key, call)) for key, call in pairs}
        run.check()
        return {key: task.result() for key, task in tasks.items()}
    except BaseException as error:
        run.record(face.error_code(error))
        current['ready'].set()
        raise
    finally:
        _group.reset(token)


def install() -> Callable[[], None]:
    original_begin = face._Run.begin
    original_capability = face._Run.capability
    original_replaying = face._Run.replaying
    original_request = face.request
    original_restore = face.Executor._restore

    def replaying(run: Any) -> bool:
        return bool(state(run)['remaining'])

    def begin(run: Any, kind: str, payload: Any) -> tuple[dict[str, Any], bool]:
        run.check()
        if run.pausing or (kind == 'interaction' and _group.get()):
            fail(run)
        current = state(run)
        key = _branch.get()
        mark = None
        if key is not None:
            ordinal = current['ordinals'].get(key, 0)
            if ordinal > 99999:
                fail(run)
            current['ordinals'][key] = ordinal + 1
            mark = f'{key}/{ordinal}'
            index = current['index'].get(mark)
            if index is not None and index not in current['remaining']:
                fail(run, 'unrecoverable')
        else:
            index = min(current['remaining']) if current['remaining'] else None
            if index is not None and 'branch' in current['entries'][index]:
                fail(run, 'unrecoverable')
        digest = face._digest(payload)
        if index is not None:
            entry = current['entries'][index]
            if entry['kind'] != kind or entry['digest'] != digest or 'result' not in entry:
                fail(run, 'unrecoverable')
            consumed(run, index)
            return entry, True
        if key is None:
            run.frontier()
        elif any('branch' not in current['entries'][index] for index in current['remaining']):
            fail(run, 'unrecoverable')
        entry = {'kind': kind, 'digest': digest, **({'request': face._json(payload)} if kind == 'interaction' else {})}
        if mark is not None:
            entry['branch'] = mark
        run.session.journal.append(entry)
        run.cursor += 1
        return entry, False

    async def request(op: str, payload: dict[str, Any], **kwargs: Any) -> Any:
        run = face._run.get()
        if run is not None and _group.get():
            if remaining_branches(run):
                await state(run)['ready'].wait()
            run.frontier()
        return await original_request(op, payload, **kwargs)

    async def capability(run: Any, payload: dict[str, Any]) -> Any:
        key = _branch.get()
        if key is None:
            return await original_capability(run, payload)
        ordinal = state(run)['ordinals'].get(key, 0)
        run.calls += 1
        entry, replayed = run.begin('capability', {'name': payload['name'], 'input': payload['input']})
        if replayed:
            return face._json(entry['result'])
        try:
            result = await request('capability', {**payload, 'effectScope': f'dspy/{run.conversation}/{run.ordinal}/{key}/{ordinal}'})
            run.check()
            entry['result'] = face._json(result)
            return result
        except GalaxieError as error:
            fail(run, error.code)

    def restore(executor: Any, checkpoint: bytes, metadata: bytes, session: str) -> str:
        try:
            raw = json.loads(checkpoint)
            stripped = json.loads(checkpoint)
            marks = set()
            for entry in stripped['journal']:
                if 'branch' not in entry:
                    continue
                mark = entry.pop('branch')
                if (entry.get('kind') not in {'model', 'capability'} or type(mark) is not str
                    or MARK.fullmatch(mark) is None or mark in marks):
                    raise ValueError()
                marks.add(mark)
            identifier = original_restore(executor, json.dumps(stripped).encode(), metadata, session)
            if raw['status'] == 'paused':
                executor._sessions[identifier].journal = raw['journal']
                executor._sessions[identifier].bounded()
            return identifier
        except (Exception, face._Termination):
            raise GalaxieError('unrecoverable') from None

    replacements = [(face._Run, 'begin', begin), (face._Run, 'capability', capability),
                    (face._Run, 'replaying', property(replaying)), (face, 'request', request),
                    (face.Executor, '_restore', restore)]
    for owner, name, replacement in replacements:
        setattr(owner, name, replacement)

    def uninstall() -> None:
        for (owner, name, _), original in zip(replacements, [original_begin, original_capability, original_replaying, original_request, original_restore], strict=True):
            setattr(owner, name, original)

    return uninstall
