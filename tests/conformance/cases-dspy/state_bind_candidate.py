# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Test-only frozen descriptor binding; never installed by shipped code."""

from collections.abc import Callable, Iterator
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import re
from typing import Any

from dspy.primitives.base_module import BaseModule
from galaxie._bridge import GalaxieError
from galaxie.dspy import Executor

BINDING = 'stateBinding'


def encode(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')


def manifest_digest(files: dict[str, bytes]) -> str | None:
    if not files:
        return None
    entries = [[name, hashlib.sha256(content).hexdigest()] for name, content in sorted(files.items())]
    return hashlib.sha256(encode(entries)).hexdigest()


def descriptor_digest(root: Path, scope: str = 'state') -> str | None:
    assert scope in {'state', 'all'}
    return manifest_digest({
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in root.rglob('*')
        if path.is_file() and '__pycache__' not in path.relative_to(root).parts
        and path.suffix in ({'.json'} if scope == 'state' else {'.py', '.json'})
    })


def install(root: Path, scope: str = 'state') -> Callable[[], None]:
    digest = descriptor_digest(root, scope)
    original_snapshot, original_restore = Executor._snapshot, Executor._restore

    def snapshot(self: Executor, conversation: str, session: str, *, compact: bool = False) -> tuple[bytes, bytes]:
        checkpoint, metadata = original_snapshot(self, conversation, session, compact=compact)
        if digest is not None and json.loads(checkpoint)['status'] == 'paused':
            return checkpoint, encode({**json.loads(metadata), BINDING: digest})
        return checkpoint, metadata

    def restore(self: Executor, checkpoint: bytes, metadata: bytes, session: str) -> str:
        try:
            raw, meta = json.loads(checkpoint), json.loads(metadata)
            if isinstance(raw, dict) and raw.get('status') == 'paused' and isinstance(meta, dict) and BINDING in meta:
                bound = meta.pop(BINDING)
                if type(bound) is not str or re.fullmatch('[0-9a-f]{64}', bound) is None or bound != digest:
                    raise ValueError()
                metadata = encode(meta)
        except Exception:
            raise GalaxieError('unrecoverable') from None
        return original_restore(self, checkpoint, metadata, session)

    setattr(Executor, '_snapshot', snapshot)
    setattr(Executor, '_restore', restore)

    def uninstall() -> None:
        setattr(Executor, '_snapshot', original_snapshot)
        setattr(Executor, '_restore', original_restore)

    return uninstall


@contextmanager
def installed(root: Path, scope: str = 'state') -> Iterator[None]:
    uninstall = install(root, scope)
    try:
        yield
    finally:
        uninstall()


@contextmanager
def loaded_files(root: Path) -> Iterator[dict[str, bytes]]:
    """Comparison only: globally wrap DSPy 3.4.1's path-based load method."""
    original = BaseModule.load
    files: dict[str, bytes] = {}

    def load(self: BaseModule, path: Any, *args: Any, **kwargs: Any) -> Any:
        source = Path(path)
        files[source.relative_to(root).as_posix()] = source.read_bytes()
        return original(self, path, *args, **kwargs)

    setattr(BaseModule, 'load', load)
    try:
        yield files
    finally:
        setattr(BaseModule, 'load', original)
