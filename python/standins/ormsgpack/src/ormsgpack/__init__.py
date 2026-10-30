# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: AGPL-3.0-only

"""Limited, independently written stand-in for ormsgpack 1.13.0.

The upstream package this replaces is licensed under Apache-2.0 or MIT.
No upstream implementation is included. This uses msgpack's own implementation
and only supplies the serializer surface needed by this browser example.
It does not promise ormsgpack wire compatibility or general object support.
"""

import msgpack
from collections.abc import Callable
from typing import Any, cast

__version__ = "1.13.0"
Ext = msgpack.ExtType
MsgpackEncodeError = msgpack.PackException
MsgpackDecodeError = msgpack.UnpackException
OPT_NON_STR_KEYS = 1
OPT_PASSTHROUGH_DATACLASS = 2
OPT_PASSTHROUGH_DATETIME = 4
OPT_PASSTHROUGH_ENUM = 8
OPT_PASSTHROUGH_UUID = 16
OPT_REPLACE_SURROGATES = 32


def packb(value: Any, *, default: Callable | None = None, option: int = 0) -> bytes:
    return cast(bytes, msgpack.packb(value, default=default, use_bin_type=True))


def unpackb(
    value: bytes, *, ext_hook: Callable[[int, bytes], Any] = Ext, option: int = 0,
) -> Any:
    return msgpack.unpackb(value, raw=False, strict_map_key=False, ext_hook=ext_hook)
