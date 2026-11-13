# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Test-local driver scope; no change to the shipped execution path."""

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from itertools import count

from galaxie import GalaxieError
from galaxie._bridge import ERROR_MESSAGES


@dataclass(slots=True)
class Scope:
    id: int
    failure: str | None = None

    def latch(self, code: str) -> None:
        if self.failure is None:
            self.failure = code if code in ERROR_MESSAGES else 'invalid'


current: ContextVar[Scope | None] = ContextVar('tool_execution_candidate', default=None)
identities = count(1)


def check() -> Scope:
    scope = current.get()
    # Zero is a closed identity, including in child contexts that outlive the run.
    if scope is None or scope.id == 0:
        raise GalaxieError('unsupported')
    if scope.failure is not None:
        raise GalaxieError(scope.failure)
    return scope


@contextmanager
def execution():
    scope = Scope(next(identities))
    token = current.set(scope)
    try:
        try:
            yield scope
        except GalaxieError as error:
            if scope.failure is not None and error.code != scope.failure:
                raise GalaxieError(scope.failure) from None
            raise
        else:
            check()
    finally:
        scope.id = 0
        try:
            current.reset(token)
        except ValueError:
            # Async generator finalization can run in a different context. The
            # shared closed identity still refuses work in every copied context.
            pass


class ScopedGraph:
    def __init__(self, graph):
        self.graph = graph

    def __getattr__(self, name):
        return getattr(self.graph, name)

    async def astream(self, *args, **kwargs):
        with execution():
            stream = self.graph.astream(*args, **kwargs)
            try:
                async for item in stream:
                    yield item
            finally:
                await stream.aclose()
