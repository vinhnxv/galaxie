# ADR-0008: Code-first agent definition, generated manifest

- **Status:** Proposed
- **Date:** 2026-10-28
- **Related:** brief §4.3, §13.2, §14.2

## Context

The v0.1 brief had a hand-written JSON manifest next to the code. Two hand-maintained descriptions of the same agent drift. The capability contract is the "port" that makes reuse work, so host bindings should be checked against it by the compiler, not only at runtime.

## Decision

- The agent is defined in TypeScript with `defineAgentDefinition(...)`: ID, version, executor, input schema, versioned capabilities with schemas and kinds, model roles with required features, UI requirements and skills.
- Capabilities are versioned names (`lessons.get@1`). A breaking change is a new version.
- Host bindings are type-checked against the definition at build time and validated at runtime.
- A build script generates the manifest JSON and JSON Schemas (Zod v4 `z.toJSONSchema`, to verify at the pinned version), plus integrity metadata.
- The manifest is an output for inspection and distribution, never the source of truth.

## Alternatives considered

- **JSON manifest as the source (v0.1).** Rejected: drift and no type checking.
- **YAML definitions.** Rejected: same drift, and agents are code anyway.

## Consequences

- The definition must stay serializable enough to generate the manifest; closures belong in `create(host)`, not in the definition.
- A published CLI is not needed in the MVP; a build script is enough.

## Verification

- M4: the generated manifest matches the definition (snapshot test); a host binding with the wrong schema fails type checking.
- AT-05.
