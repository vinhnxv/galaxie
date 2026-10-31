# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

from collections.abc import Callable, Mapping
from contextvars import ContextVar
from typing import Any

from ._bridge import GalaxieError, request

# A framework face may observe failed calls so author code cannot swallow a terminal code.
failures: ContextVar[Callable[[str], None] | None] = ContextVar('galaxie_capability_failures', default=None)


async def call(
    name: str,
    input: Any,
    config: Mapping[str, Any] | None = None,
    *,
    effect_scope: str | None = None,
) -> Any:
    if not isinstance(name, str) or not name:
        raise GalaxieError("invalid")
    payload = {"name": name, "input": input}
    if effect_scope is not None:
        if not isinstance(effect_scope, str) or not effect_scope or config is not None:
            raise GalaxieError("invalid")
        payload["effectScope"] = effect_scope
    if config is not None:
        metadata = config.get("metadata") or {}
        configurable = config.get("configurable") or {}
        scope = metadata.get("langgraph_checkpoint_ns", configurable.get("checkpoint_ns"))
        if scope is not None:
            if not isinstance(scope, str):
                raise GalaxieError("invalid")
            payload["effectScope"] = scope
    try:
        return await request("capability", payload)
    except GalaxieError as error:
        observer = failures.get()
        if observer is not None:
            observer(error.code)
        raise
