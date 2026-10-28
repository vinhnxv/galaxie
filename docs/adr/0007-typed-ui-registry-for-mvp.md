# ADR-0007: Typed UI registry with headless reference components

- **Status:** Proposed
- **Date:** 2026-10-28
- **Related:** brief §4.3, §11; ADR-0004, ADR-0012
- **Revisions:** 2026-10-28, with brief 0.3: Spike C runs before M2 instead of in M0.
  - 2026-10-29: recorded Spike C browser evidence; status remains Proposed.

## Context

The MVP needs four domain components (`Quiz`, `WritingPrompt`, `Feedback`, `Progress`). In the MVP the graph chooses the component and the LLM fills its data (graph-selected UI). There are several ecosystem options: json-render, A2UI v0.9 with an official React renderer, MCP Apps, CopilotKit, Hashbrown and Tambo. Each brings a protocol and version churn that the MVP does not need yet.

The real cost of reuse is that every host must render every catalog component in its own design system.

## Decision

- Build a small typed registry: component ID (`education.Quiz/v1`) → props schema (Zod), allowed actions, and a React component.
- Ship headless, unstyled reference components for each catalog entry, so a host can start with them and theme later.
- The registry validates props, rejects unknown components and actions with typed errors, and applies the URL allowlist.
- Action labels and confirmation text come from the registry and the real parameters, never from model output (ADR-0012).
- Keep an adapter boundary so json-render, A2UI or MCP Apps can be added later.

## Alternatives considered

- **json-render as the MVP renderer (v0.1 proposal).** Deferred: fits LLM-composed UI better than graph-selected UI; revisit when that mode arrives.
- **A2UI renderer.** Deferred: portability is not an MVP goal.
- **MCP Apps iframes.** Deferred: useful when MCP servers ship their own UI.

## Consequences

- We own a small amount of renderer code and its tests.
- Portability claims wait for a second renderer (Phase 6).

## Verification

- Spike C (2026-10-29, `spikes/c-ui-path/`): [recorded Chromium evidence](../../spikes/c-ui-path/README.md) rendered `education.Quiz/v1` through a Zod schema, action allowlist and React component from `run.pending`, both fresh and restored. Unknown components, invalid props and actions produced typed errors without rendering the rejected Quiz; local answers were lost on reload. The spike registry did not apply the URL allowlist itself: AE6 covered only core's `checkInteractionUrls` on the restore path, so schema-declared registry URL checks remain unverified for M2.
- AT-06, AT-07, AT-21, AT-27, AT-28.
