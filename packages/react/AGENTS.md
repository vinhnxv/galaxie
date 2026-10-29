# @galaxie/react: coding guidance

## Purpose

Render schema-checked agent interactions through trusted React components and a
separate host confirmation prompt. The host owns the instance lifecycle.
See [usage and confirmation wiring](README.md).

## Entry points

- `@galaxie/react` is the only entry; inspect [src/index.ts](src/index.ts).
- `createRegistry`, `defineComponent`, `useAgentSnapshot` and `AgentSurface`
  bind and render agent interactions.
- `educationComponents`, `Quiz`, `WritingPrompt`, `Feedback` and `Progress`
  provide headless reference entries with exported props/action types.
- `defineConfirmations` and `ConfirmationPrompt` use a separate host registry.

## Do

Build the trusted registry and pass its bindings when creating the instance:

```ts
import { createRegistry, educationComponents } from '@galaxie/react';

const registry = createRegistry({ components: educationComponents });
const ui = registry.bindings({ surfaces: ['lesson-main'] });
```

- Supply that `ui` to `runtime.create`; mount `AgentSurface` with the same registry
  and assigned `surfaceId`.
- Render model-produced props as React text; keep labels and handlers in host code.
- Declare every loaded or linked URL in a custom entry's `urls` extractor; each
  extracted value must be used verbatim as one attribute.
- Mount `ConfirmationPrompt` outside `AgentSurface`; derive rows from validated
  arguments and pass logout/takeover signals to core confirmations.

## Never

- Never interpret model text as HTML, JavaScript or event handlers.
- Never use `dangerouslySetInnerHTML` for model-produced props.
- Never let an agent catalog provide password or payment components.
- Never approve a capability during render or through an agent-owned component.
- Never create, prepare or dispose instances inside the surface.

## Limits

Origin allowlists constrain origins, not paths or queries. Entry URL extractors
are trusted code. Drafts are component-local and reset on remount or reload.
Same-origin page scripts can call the host approval API; confirmations do not
replace backend authorization. See [the broker flow](../../docs/system-design.md#83-a-capability-call).

## Tests

[test/](test/) contains Chromium registry, component, surface, Strict Mode and
confirmation tests. Run `pnpm exec vitest run --project browser packages/react/test`
from the repository root; `pnpm test tests/conformance/react-surface.test.tsx` covers the
real LangGraph resume integration. Models remain mocked. Run `pnpm check`
before completion, including its React import dependency guard.
