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

The [adapter example](../adapter-langgraph/README.md) supplies a graph and an
agent definition. Hosts bind capabilities and model routes explicitly; direct
agent platform access bypasses those controls.

See [coding guidance](AGENTS.md), [runtime contracts](../../docs/system-design.md#6-core-runtime-and-contracts),
[the mandatory baseline](../../docs/adr/0012-security-baseline.md) and
[conformance coverage](../../tests/conformance/README.md).
Code is Apache-2.0 (see [LICENSE](../../LICENSE)).
