# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Build a deliberately limited, same-name ormsgpack wheel for this spike only."""

import base64
import hashlib
import io
from pathlib import Path
import zipfile

SOURCE = '''
# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
"""Spike-only API subset; not an ormsgpack compatibility implementation."""
from msgpack.fallback import Packer, unpackb as _unpackb
from msgpack import ExtType as Ext
MsgpackEncodeError = TypeError
OPT_NON_STR_KEYS = 1
OPT_PASSTHROUGH_DATACLASS = 2
OPT_PASSTHROUGH_DATETIME = 4
OPT_PASSTHROUGH_ENUM = 8
OPT_PASSTHROUGH_UUID = 16
OPT_REPLACE_SURROGATES = 32

def packb(value, *, default=None, option=0):
    if option & ~63:
        raise ValueError("Unsupported spike serializer option.")
    return Packer(default=default, use_bin_type=True).pack(value)

def unpackb(value, *, ext_hook=Ext, option=0):
    if option & ~OPT_NON_STR_KEYS:
        raise ValueError("Unsupported spike serializer option.")
    return _unpackb(value, raw=False, strict_map_key=False, ext_hook=ext_hook)
'''


def build() -> None:
    name = "ormsgpack-1.13.0.dist-info"
    files = {
        "ormsgpack/__init__.py": SOURCE.encode(),
        f"{name}/METADATA": b"Metadata-Version: 2.1\nName: ormsgpack\nVersion: 1.13.0\nRequires-Dist: msgpack==1.1.2\n",
        f"{name}/WHEEL": b"Wheel-Version: 1.0\nGenerator: galaxie-spike\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
    }
    records = []
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as wheel:
        for path, value in files.items():
            digest = base64.urlsafe_b64encode(hashlib.sha256(value).digest()).rstrip(b"=").decode()
            records.append(f"{path},sha256={digest},{len(value)}")
            info = zipfile.ZipInfo(path, (2026, 10, 30, 0, 0, 0))
            wheel.writestr(info, value)
        wheel.writestr(
            zipfile.ZipInfo(f"{name}/RECORD", (2026, 10, 30, 0, 0, 0)),
            "\n".join(records + [f"{name}/RECORD,,"]),
        )
    target = Path(__file__).parent / ".cache" / "ormsgpack-1.13.0-py3-none-any.whl"
    target.parent.mkdir(exist_ok=True)
    target.write_bytes(buffer.getvalue())


if __name__ == "__main__":
    build()
