# @galaxie/eslint-plugin: coding guidance

## Purpose

Flag direct platform and provider access in reviewed, bundled agent packages.
These are development lint rules, without runtime enforcement.
See [usage and limits](README.md).

## Entry points

- `@galaxie/eslint-plugin` exports a default plugin from [src/index.ts](src/index.ts).
- `configs.recommended` is an ESLint 10 flat config enabling every rule as an error.
- `rules` contains `no-direct-network`, `no-direct-storage`, `no-dom`, `no-eval`
  and `no-direct-model`; there are no public subpaths.

## Do

Apply the recommended config to agent sources:

```ts
import galaxie from '@galaxie/eslint-plugin';

export default [galaxie.configs.recommended];
```

- Scope linting to agent packages; hosts legitimately own network, storage and DOM.
- Supply a TypeScript-capable parser on TypeScript 6 for TypeScript agent sources,
  following [ADR-0013](../../docs/adr/0013-typescript-first-implementation.md).
- Keep scope analysis aware of shadowed local bindings.
- Use host capabilities instead of direct network, and
  `host.langchain.chatModel(role)` instead of provider imports.
- Keep report payloads limited to matched API names and configured prefixes.

## Never

- Never describe these rules as a sandbox or runtime policy enforcement.
- Never evaluate agent code while linting or add runtime dependencies for the rules.
- Never assume aliases or dependency-supplied APIs are fully detected.
- Never add model text, arguments or full source text to lint report data.
- Never use a provider allow exemption without reviewing the router bypass it permits.
- Never render model-produced props as HTML; use React text in trusted components.

## Limits

There is no type information or data-flow analysis. Aliases, dependencies and
runtime-built code can escape detection. HTML sink checks match names on any
receiver and do not determine a value's source. The repository does not install
or test a TypeScript ESLint parser; it uses Biome for repository linting.

## Tests

Run `pnpm exec vitest run --project node packages/eslint-plugin/test` for
[RuleTester cases](test/rules.test.ts), and
`pnpm exec vitest run --project node tests/conformance/eslint-tutor.node.test.ts`
for the tutor lint conformance check. The latter strips TypeScript with Node 24;
no model runs. Run `pnpm check` before completion.
