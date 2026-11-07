# @galaxie/core

Framework-neutral contracts and the host runtime for reviewed, bundled browser
agents. Core owns lifecycle, policy, budgets, interactions, capability dispatch,
optional recovery and allowlisted OpenTelemetry spans. It calls the OpenTelemetry
API; the host registers the SDK and exporter.

## Install

This is a private workspace package, not a published npm release. From this
repository's root, use Node 24 and pnpm 11, run `pnpm install --frozen-lockfile`,
then `pnpm build`. Workspace consumers declare `@galaxie/core` as `workspace:*`.
Peer requirements are in [package.json](package.json).

## Entry points

`@galaxie/core` exports runtime APIs and framework-neutral contracts. It uses no
unguarded browser globals and can import and run without page APIs. Optional
storage persistence and development page warnings keep their feature guards.

`@galaxie/core/browser` exports `acquireOwnership`, `watchInvalidation`,
`Ownership`, `OwnershipLostReason`, `OwnershipOptions`, `OwnershipResult`,
`InvalidationOptions` and `InvalidationWatcher`. Ownership requires Web Locks and
BroadcastChannel; invalidation requires BroadcastChannel and also works in a Worker.

Moving these functions and types out of the main entry is a breaking change to
the public API of this package, which has not been published. Update host imports:

```ts
import { acquireOwnership, watchInvalidation } from '@galaxie/core/browser';
```

## Minimal host setup

```ts
import { createRuntime } from '@galaxie/core';
import { createLangGraphAdapter } from '@galaxie/adapter-langgraph';

const runtime = createRuntime({
  appId: 'lesson-app',
  executors: [createLangGraphAdapter()],
});
// Create and prepare instances, then handle their snapshots and interactions.
// At host teardown:
await runtime.dispose();
```

Choose `appId` and each instance's `principalScope` as strings of 1 to 128
characters from `A-Z a-z 0-9 . _ : -`. Core checks `appId` in `createRuntime`
and `principalScope` first in `runtime.create`, before creating instance state
or calling hooks. Invalid values fail with fixed `invalid` errors. Ownership,
invalidation and IndexedDB storage use the same rule. Derive the principal from
trusted host session context and use the same pair for runtime and storage.

The [adapter example](../adapter-langgraph/README.md) supplies a graph and an
agent definition. Hosts bind capabilities and model routes explicitly; direct
agent platform access bypasses those controls.

See [coding guidance](AGENTS.md), [runtime contracts](../../docs/system-design.md#6-core-runtime-and-contracts),
[the mandatory baseline](../../docs/adr/0012-security-baseline.md) and
[conformance coverage](../../tests/conformance/README.md).
Code is Apache-2.0 (see [LICENSE](../../LICENSE)).

## Materialized pending surfaces

Core depends on `@galaxie/ui-protocol` through its public root; its existing peers
remain unchanged. Hosts can bind `ui.catalogs` by catalog ID alongside `ui.surfaces`
and registered component actions. Core validates materialized interrupt records
before publication and again on restore, using the run's payload and UI-element
limits and the whole-surface URL/private-value policy. Missing bindings fail closed.

`materializeSurface({ binding, catalog, previous?, messages, limits, isAllowedUrl })`
wraps the protocol reducer for trusted node code. `parseSurfaceRecord` checks the
plain JSON record shape, and `pendingFromSurface` creates a detached, frozen legacy
projection plus `surface`. These helpers do not authorize publication.
`surfaceFromRequest(request, catalogId)` maps a representable legacy request to a
single `root` component; props containing `id` or `component` return `undefined`.
Legacy requests still follow their original validation path.

Surface events additionally supply `surfaceAction: { revision, componentId, dataModel }`.
Core checks the committed revision, registered action and payload, and changes only
to paths related to a component's data binding. Changed string leaves receive
`private-user` before inbox acceptance. Only `{ action, payload }` resumes the node.
See [the runtime contract](../../docs/system-design.md#6-core-runtime-and-contracts)
for checkpoint, restore and replay limits.
