---
title: M4 ESLint Plugin for Agent Packages - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M4 ESLint Plugin for Agent Packages - Plan

## Goal Capsule

- **Objective:** ship `@galaxie/eslint-plugin`, which flags patterns that agent package code must avoid (brief §9.7 C, §11 and §16.6):
  - direct network calls;
  - direct storage;
  - DOM access;
  - HTML rendering of model output;
  - `eval`-style code execution;
  - direct model construction that bypasses the router (ADR-0002).

  It is a linting aid, not a sandbox (brief §9.7 C). This is M4 slice 6.
- **Means:**
  - a new package, `packages/eslint-plugin`, with zero runtime dependencies. Its rules use the ESTree AST and scope analysis, without type information.
  - `RuleTester` tests, and a conformance test that lints the tutor's source;
  - docs.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0002, ADR-0012 and ADR-0013 (TypeScript 6 for compiler-API tools). Do not edit any ADR.
  3. This plan.
  4. Brief §9.7, §11, §15 and §16.6.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous, in Node. Work offline except for `git push` and `gh` at the end. Work on the existing branch `m4/eslint-plugin` and open one pull request against `main`.
  - The branch holds one commit with this plan, `packages/eslint-plugin/package.json` (dev dependency and peer `eslint` 10.13.0) and the updated, installed `pnpm-lock.yaml`.
  - Do not change any dependency further.
  - Run U1 to U4 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - a dependency or the lockfile would change again, including adding `typescript-eslint` or any parser;
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - tutor source would need to change to lint cleanly;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Plugin shape (`packages/eslint-plugin/src/index.ts`)**

- R1. The default export is an ESLint 10 flat-config plugin with three parts:
  - `meta: { name: '@galaxie/eslint-plugin', version }`, with the version read from a constant that a test keeps equal to `package.json`;
  - `rules`;
  - `configs.recommended`, a flat config object that registers the plugin under the `galaxie` namespace and enables every rule as `error`.

  Rule modules use the `Rule.RuleModule` types imported with `import type` from `eslint`. There are no value imports from `eslint` or anything else. Node types come only from `import type { Rule, Scope } from 'eslint'`, as `Rule.Node` or listener parameter types derived from `Rule.RuleListener`. pnpm keeps `@types/estree` private to eslint, so `estree` is not resolvable without a new dependency. Every rule has `meta.type: 'problem'`, `meta.docs.description`, a `meta.schema` and fixed `messageId` messages. No rule has autofix.
- R2. **Global resolution.** A name counts as a platform global only when the scope manager resolves it to no local binding: its reference is in `through` of the global scope, or its variable has no `defs`. A local variable, parameter or import that shadows `fetch`, `document` or similar is never flagged. Member forms are also matched:
  - on the unshadowed globals `globalThis`, `window`, `self` and `global`;
  - with static names (`x.fetch` or `x['fetch']`);
  - when chained, as in `globalThis.window.fetch`.

  A computed member with a non-literal key on one of those globals, such as `globalThis[name]`, is reported as `dynamicGlobal`.

**Rules**

- R3. `galaxie/no-direct-network` reports these uses of the global:
  - calls to `fetch`;
  - `new XMLHttpRequest`, `new WebSocket`, `new EventSource`, `new WebTransport` and `new RTCPeerConnection`;
  - `navigator.sendBeacon`;
  - `importScripts`.

  The message says to use a host-bound capability.
- R4. `galaxie/no-direct-storage` reports any reference to these:
  - the globals `localStorage`, `sessionStorage`, `indexedDB`, `caches` and `cookieStore`;
  - `document.cookie`;
  - `navigator.storage`.

  The message says that the host owns storage and checkpoints.
- R5. `galaxie/no-dom` reports any reference to the globals `document`, `window`, `DOMParser` and `HTMLElement`, and any reference to `navigator` other than the members already reported by R3 and R4. It also reports, anywhere and not only on globals:
  - assignments to the members `innerHTML`, `outerHTML` and `srcdoc`;
  - calls to the members `insertAdjacentHTML` and `createContextualFragment` on any receiver, and to `write` and `writeln` when the object is `document`;
  - JSX attributes named `dangerouslySetInnerHTML`.

  The message says that the host renders UI through the catalog. The HTML-sink cases have their own `messageId`, which says that model output must render as text.

  **De-duplication.** Each node is reported once.
  - no-dom does not report a `window`, `document` or `navigator` reference that is the object of a member already reported by R3 or R4, such as `window.fetch`, `window.localStorage` or `document.cookie`.
  - For an HTML-sink call such as `document.write(x)`, no-dom reports only the sink `messageId`, not the `document` reference as well.
- R6. `galaxie/no-eval` reports:
  - `eval(...)` and indirect forms of it, such as `(0, eval)(...)`;
  - `new Function(...)` and `Function(...)` on the global;
  - `setTimeout`, `setInterval` and `setImmediate` whose first argument is a string literal or template literal;
  - `import()` whose specifier is not a string literal.
- R7. `galaxie/no-direct-model` reports:
  - `import` declarations, `export ... from` declarations and string-literal `import()` of these sources and their subpaths: `@langchain/openai`, `@langchain/anthropic`, `@langchain/google-genai`, `@langchain/ollama`, `@langchain/mistralai`, `@langchain/groq`, `@langchain/community`, `@mlc-ai/web-llm`, `openai`, `@anthropic-ai/sdk` and `@galaxie/models`;
  - any reference to the global `LanguageModel`, the Prompt API.

  Its options are `{ allow?: string[]; extraSources?: string[] }`, exact source prefixes validated by `meta.schema`. The message says to call `host.langchain.chatModel(role)`, so routing, labels, consent and budgets apply.
- R8. Reports carry only the matched name, never source text beyond it.

**Tests**

- R9. `packages/eslint-plugin/test/rules.test.ts` uses ESLint's `RuleTester` with the default espree parser, `ecmaVersion: 'latest'`, `sourceType: 'module'` and JSX enabled. It binds `RuleTester.describe`, `it` and `itOnly` to Vitest. Each rule has:
  - valid cases: shadowed locals, such as a `fetch` parameter, an imported `document` or a local `const window = {}`; unrelated members, such as `obj.fetch()` on a local and `element.textContent = x`; and allowed sources;
  - invalid cases for every listed form, including the `globalThis`, `window`, `self` and computed forms, with the exact `messageId`.

  One test checks `meta.version` against `package.json`, and that `configs.recommended` enables every rule.
- R10. `tests/conformance/eslint-tutor.node.test.ts` lints every `examples/english-tutor/src/**/*.ts` file with the recommended config, through the `ESLint` Node API, with `overrideConfigFile: true`, `lintText` and the real `.ts` path as `filePath`. Without a `files` pattern, ESLint ignores `.ts` paths, so it uses `overrideConfig: [{ ...recommended, files: ['**/*.ts'] }]`. It also asserts that no message has a null `ruleId`, which catches an ignored-file warning.
  - Before linting, it removes TypeScript syntax with `stripTypeScriptTypes(code, { mode: 'strip' })` from `node:module`, so positions survive and no TypeScript parser is needed.
  - It expects zero messages.
  - It also lints one known-bad snippet through the same path and expects the exact rule IDs, so a misconfigured run cannot pass silently.

**Wiring and docs**

- R11. Add `packages/eslint-plugin` to:
  - the root `typecheck` and `typecheck:ts6`, with its `tsconfig.json` and `test/tsconfig.json` modeled on `packages/core`;
  - the `build` chain;
  - the Vitest Node project, which already includes `packages/*/test`;
  - `check:deps`: `src/` may import only `import type` from `eslint`.

  `tests/conformance` does not declare `eslint`, and adding it would change the lockfile. Follow the MCP SDK precedent instead, with no change to any `package.json`. In `vitest.config.ts`, add aliases:
  - from `eslint` to `./packages/eslint-plugin/node_modules/eslint/lib/api.js`;
  - from `@galaxie/eslint-plugin` to `./packages/eslint-plugin/src/index.ts`.

  In `tests/conformance/tsconfig.json`, add matching `paths`:
  - `eslint` to `../../packages/eslint-plugin/node_modules/eslint/lib/types/index.d.ts`;
  - `@galaxie/eslint-plugin` to the plugin source.
- R12. Docs:
  - `packages/eslint-plugin/README.md` gives the flat-config usage: `import galaxie from '@galaxie/eslint-plugin'; export default [galaxie.configs.recommended]`. It names each rule, and states that TypeScript sources need a TypeScript-capable parser such as `typescript-eslint`. Under ADR-0013 that parser runs on TypeScript 6, and this repo does not test it.
  - Limits: no type information, so aliased or re-exported globals (`const f = fetch` is caught, `const g = globalThis; g.fetch()` is not), values from dependencies and runtime-built code escape it. It is a linting aid, not a sandbox.
  - Update the AGENTS.md project status paragraph, the README status and the system-design package table. Never describe the plugin as a security boundary.

### Scope Boundaries

- No type-aware rules, no `typescript-eslint`, no autofix.
- No lint run over the repo's own packages or hosts. Biome stays the repo's linter, and hosts legitimately use these APIs.
- No change to tutor source.

### Assumptions

- ESLint 10.13.0 provides `RuleTester`, the flat-config `ESLint` class with `overrideConfigFile: true`, and `sourceCode.getScope(node)`.
- Node 24's `stripTypeScriptTypes` handles the tutor sources, which use only erasable syntax, as the compiler rules require.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Parser-agnostic ESTree rules.** `typescript-eslint` would need TypeScript 6 through an alias under ADR-0013 and add a large dependency tree. Scope-based ESTree rules work under any parser that produces ESTree, and the repo tests them with espree plus Node's type stripping.
- KTD2. **Scope resolution over name matching.** Name matching would flag legitimate local bindings and teach authors to rename around the rule. Resolving to the global scope keeps false positives low.

### Output Structure

```text
packages/eslint-plugin/
  README.md
  package.json            (committed with the plan)
  tsconfig.json
  tsconfig.build.json
  src/index.ts
  src/globals.ts          (shared global-resolution helpers)
  src/rules/no-direct-network.ts
  src/rules/no-direct-storage.ts
  src/rules/no-dom.ts
  src/rules/no-eval.ts
  src/rules/no-direct-model.ts
  test/tsconfig.json
  test/rules.test.ts
tests/conformance/eslint-tutor.node.test.ts
```

### Implementation Constraints

- New files carry the SPDX header. The compiler rules in AGENTS.md apply.
- Rules never execute or evaluate the linted code.

## Implementation Units

- **U1. Package skeleton and global resolution.** R1, R2 and R11.
- **U2. Rules.** R3–R8, and R9's rule tests.
- **U3. Tutor conformance.** R10.
- **U4. Docs.** R12.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Tutor unchanged | `git diff --stat main -- examples/english-tutor` is empty. | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr` is empty. | before the PR |
| No further dependency change | `git diff --stat $(git log --reverse --format=%H main..HEAD \| head -1) -- pnpm-lock.yaml packages/eslint-plugin/package.json` is empty. | before the PR |
| Dependencies | `pnpm install --frozen-lockfile --offline` passes. | before the PR |

## Definition of Done

- U1 to U4 are complete.
- The tutor lints cleanly with the recommended config.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §9.7 C, §11, §15 (`packages/eslint-plugin/`) and §16.6.
- ADR-0002 and ADR-0013.
- `scripts/check-dependencies.ts`, `vitest.config.ts`, the root `package.json` scripts, and `packages/core` for the tsconfig layout.
- `eslint` 10.13.0 in `node_modules`, for `RuleTester`, the `ESLint` class and the `Rule` types.
