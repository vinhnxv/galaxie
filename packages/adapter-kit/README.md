# @galaxie-ai/adapter-kit

Shared text extraction, selected-provider resolution and pure Worker bridge
framing/validation helpers for galaxie executor adapters. This package registers
no executor and is an internal building block with no stable standalone API
promise. It shares the launch packages' release version.

Only the public root, `@galaxie-ai/adapter-kit`, is importable. Production imports
are limited to `@galaxie-ai/core` public exports, erased type-only references to
`@langchain/core` and its subpaths, and relative files inside this package.
No adapter, framework runtime, Node-only dependency or Worker startup belongs here.
Importing the kit reads no DOM or Worker globals. UTF-8 encoding happens on call.

Adapters retain framework predicates, native message concatenation, streaming
acceptance, executable calls, protocol envelopes and error mapping. Bridge
helpers preserve the caller's prototype, depth, identifier and size boundaries;
they do not define a replacement protocol. Provider resolution accepts an
already-selected lease and passes credentials only to its per-call factory.

Licensed under Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
