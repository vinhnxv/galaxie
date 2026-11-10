# Vendored Python wheels

`cryptography-50.0.2-cp314-abi3-pyemscripten_2026_0_wasm32.whl` replaces
Pyodide 314.0.7's `cryptography` 47.0.0 wheel for the ADK Python executor.
It is built from the upstream 50.0.2 source, including its Rust extension;
it is not the older extension with changed version metadata.

The wheel is 2,370,317 bytes. Its SHA-256 is
`735be186ffb806412a249a2020ed5b907416d5f1b50d9d5764b2f18fea3a13cc`.
Both [the lock](../requirements.lock) and the
[Worker inventory](../../packages/adapter-pyodide/src/runtime-files.ts) bind these bytes.
`node scripts/fetch-python-wheels.ts` copies the wheel into the normal ignored cache
after verifying its length and SHA-256. Hosts continue to serve the cached assets;
the Worker does not fetch from the repository or resolve dependencies.

## Build provenance

Built on macOS arm64 on 2026-11-10 with CPython 3.14.2, pyodide-build 0.39.3,
the Pyodide 314.0.7 cross-build environment, Emscripten 5.0.3 with that
environment's five Emscripten patches, Rust 1.93.0 (`wasm32-unknown-emscripten`)
and maturin 1.16.0. The runtime ABI remains `pyemscripten_2026_0`.

| Input | Source | SHA-256 |
| --- | --- | --- |
| cryptography 50.0.2 | [PyPI source distribution](https://files.pythonhosted.org/packages/9d/af/182eb91b0df3fe75c4d9f26fe70684569566745f6ba7e5c9c73a862c5252/cryptography-50.0.2.tar.gz) | `7b46165bb56eb4704e2eaaf86f3c940d19154535d9b0ca7d6d590b04060e00d5` |
| OpenSSL 4.0.3 | [Upstream release](https://github.com/openssl/openssl/releases/download/openssl-4.0.3/openssl-4.0.3.tar.gz) | `325b5c806167c13b40b1ffeadfe0248197c00eccc4cf123ec1e28d2d2fd216d9` |

OpenSSL is statically linked. It was configured through `emconfigure` with
`linux-generic32 no-shared no-asm no-engine no-dso no-tests no-srtp no-cms
no-ui-console no-threads --cross-compile-prefix=`, `CC=emcc`, `AR=emar`,
`RANLIB=emranlib` and
`CFLAGS=-O2 -fPIC -fwasm-exceptions -sSUPPORT_LONGJMP=wasm`, then built and
installed to a local prefix. Cryptography was cross-built with `pyodide build`,
that prefix as `OPENSSL_DIR` and static OpenSSL linking, using its upstream
locked Cargo dependencies. No cryptography source patch was applied.

The resulting wheel was retagged to the Pyodide ABI. The package licenses and
the linked dependencies' license files were retained or added under
`cryptography-50.0.2.dist-info/licenses/`, and the wheel's `RECORD` was regenerated.
Every `RECORD` digest and size was checked after packaging. This records the
build inputs and method; bit-for-bit rebuild reproducibility has not been verified.

Cryptography is `Apache-2.0 OR BSD-3-Clause`; OpenSSL is Apache-2.0.
The wheel also carries the license texts for the Rust dependencies, Emscripten
and musl. Hosts redistributing the wheel must retain those files.

## Verification

The shared [ADK gate](../galaxie/tests/test_adk_gate.py) checks the imported
cryptography version, checks the linked OpenSSL version on Pyodide, and exercises
the Rust X.509 verifier with a valid constrained chain and a refused wildcard
outside the CA's permitted names (GHSA-m2h6-j472-rp4c). The same source runs on
native CPython, Node Pyodide and Chromium Pyodide. The Chromium gate preserves
the host's strict CSP and Trusted Types and refuses external requests.

```sh
uv run --project python --locked pytest python/galaxie/tests/test_adk_gate.py -q
pnpm exec vitest run --project node tests/conformance/python-wheels.node.test.ts packages/adapter-pyodide/test/adk-gate.node.test.ts examples/rag-browser/test/adk-gate.node.test.ts
```

The wheel-fetch tests also reject changed bytes and file sources outside this
directory. The native and Pyodide locks agree on version 50.0.2 without changing
the Python release cutoff or the other frameworks' wheel inventories.
