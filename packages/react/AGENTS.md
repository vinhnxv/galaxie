# @galaxie-ai/react: coding guidance

## Purpose

Render materialized A2UI surfaces and legacy single-component interactions through
trusted React components and a separate host confirmation prompt. The host owns the instance lifecycle.
See [usage and confirmation wiring](README.md).

## Entry points

- `@galaxie-ai/react` is the only entry; inspect [src/index.ts](src/index.ts).
- `createRegistry`, `defineComponent`, `useAgentSnapshot` and `AgentSurface`
  bind and render agent interactions.
- `structuralComponents(catalogId)` supplies Column, Row, Text and Card separately.
- `Registry.catalogs()` builds protocol catalogs; `bindings` includes them.
- `educationComponents`, `Quiz`, `WritingPrompt`, `Feedback` and `Progress`
  provide headless reference entries with exported props/action types.
- `defineConfirmations` and `ConfirmationPrompt` use a separate host registry.
- `ModelRoutes` displays selected providers, destination classes and class-change
  notices from the instance snapshot, with optional trusted host labels.

## Do

Build the trusted registry and pass its bindings when creating the instance:

```ts
import { createRegistry, educationComponents } from '@galaxie-ai/react';

const registry = createRegistry({ components: educationComponents });
const ui = registry.bindings({ surfaces: ['lesson-main'] });
```

- This renderer is a breaking change to the launch package surface API and belongs in a 0.x minor
  release; see [releasing](../../docs/releasing.md).
- Keep legacy normalization through core's `surfaceFromRequest` and preserve legacy
  events without `surfaceAction`. Native actions include their owning component ID,
  revision and unchanged stored data model.
- Declare `child`, `children`, `bindable`, `urlProperties`, `allowedParents` and
  `allowedChildren` where needed. Child references remain schema properties; rendered
  children arrive as optional `ComponentProps.children`.
- Preserve native tree identity across revisions of the same surface. Reset only
  interaction status, guards and reports on interaction/view revision changes.
- Keep one fixed-text polite change region on successful renders. Compare component
  maps structurally; data-only revisions and first render do not announce or focus.
- Map explicit accessibility label/description/live/hidden through the wrapper;
  preserve native/domain semantics and wrapper-free rendering when absent.
- Supply that `ui` to `runtime.create`; mount `AgentSurface` with the same registry
  and assigned `surfaceId`.
- Render model-produced props as React text; keep labels and handlers in host code.
- Mount `ModelRoutes` beside the run status, outside `AgentSurface`. Its polite
  live region stays mounted before selection; restored instances show a role
  only after its next routed call. Localize destination names through its props.
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
are trusted code. Drafts are component-local, survive compatible native surface
revisions and reset on remount or reload. Material-change detection compares whole component maps.
Bindings are read-only; no renderer functions are registered or evaluated. The
renderer component cap is 50, matching core's default UI budget.
Same-origin page scripts can call the host approval API; confirmations do not
replace backend authorization. See [the broker flow](../../docs/system-design.md#83-a-capability-call).

## Tests

[test/](test/) contains Chromium registry, component, surface, Strict Mode and
confirmation and model-route display tests. Run `pnpm exec vitest run --project browser packages/react/test`
from the repository root; `pnpm test tests/conformance/react-surface.test.tsx` covers the
real LangGraph resume integration; `tests/conformance/react-a2ui.test.tsx` covers
composed surfaces with real core and a fake executor. Models remain mocked. Run `pnpm check`
before completion, including its React import dependency guard.
