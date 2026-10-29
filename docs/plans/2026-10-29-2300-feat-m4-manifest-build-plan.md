---
title: M4 Manifest and Integrity Build Script - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M4 Manifest and Integrity Build Script - Plan

## Goal Capsule

- **Objective:** generate an agent package's manifest JSON, its JSON Schemas and integrity metadata from the code-first definition at build time (brief §13.2–13.3 and §16.6, ADR-0008). Hosts and CI can then verify a built package against the manifest. This is M4 slice 5.
- **Means:**
  - a pure `createManifest(definition)` in `@galaxie/core`;
  - a Node build script, `scripts/build-manifest.ts`, that writes and verifies the files;
  - wiring for `examples/english-tutor`;
  - tests on Node.
- **Authority, highest first:**
  1. `AGENTS.md`.
  2. Accepted ADRs, in particular ADR-0012 and ADR-0014. ADR-0008 is Proposed; this slice implements its "build script" decision. Do not edit any ADR.
  3. This plan.
  4. Brief §13.2, §13.3 and §16.6.
  5. `docs/system-design.md`.
- **Execution profile:** autonomous and offline, in Node. Work on the existing branch `m4/manifest`, which holds one commit with this plan, and open one pull request against `main`. Run U1 to U4 in order, with `pnpm check` after each.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - a tutor schema cannot be represented as JSON Schema, so the tutor's schemas would have to change;
  - an existing test assertion must change;
  - a conformance golden or the compatibility matrix would change;
  - an ADR would change;
  - a dependency or `pnpm-lock.yaml` would change;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges.

---

## Product Contract

### Requirements

**Manifest generation (`packages/core/src/manifest.ts`, exported from the package root)**

- R1. `createManifest(definition: AgentDefinition, options: { entry: string }): { manifest: AgentManifest; schemas: Readonly<Record<string, unknown>> }` is a pure function. It has no I/O and no Node or browser API. `entry` is the package-relative POSIX path of the module that exports the definition, such as `./dist/index.js`.
- R2. The manifest has these fields, with names from brief §13.2:
  - `schemaVersion: '0.2'`, and the definition's `id`, `version` and `executor`;
  - `entry`;
  - `inputSchema`, a package-relative path;
  - `requiredCapabilities` and `optionalCapabilities`: each maps a capability name to `{ kind, input, output }`, where `input` and `output` are schema paths;
  - `models`, `ui` and `skills`, copied from the definition. Absent optional groups are omitted, never written as `null`.

  The function never reads or adds anything outside the definition, so credentials and policy grants cannot appear.
- R3. **Schemas.** Each schema is converted through Standard JSON Schema (`schema['~standard'].jsonSchema.input`) with target `draft-2020-12`. This is the same interface `readAnnotations` uses, so `x-galaxie` labels and shapes survive.
  - Unlike `readAnnotations`, an unrepresentable schema fails with `GalaxieError('unsupported', 'The schema cannot be represented.')`. The manifest must describe the schema faithfully, so the script never writes `{}` for an unrepresentable part.
  - A schema without Standard JSON Schema also fails `unsupported`.
  - Custom refinements (`.refine`, `.superRefine`, `.check`) have no JSON Schema form, and Zod drops them without an error. This is expected and not a stop condition. For example, the tutor's `score <= total` refinement is absent from the manifest. The runtime Zod validation stays authoritative.
  - Schema paths are `./schemas/input.json`, `./schemas/<capability>.input.json` and `./schemas/<capability>.output.json`. The capability name keeps its `@`, for example `./schemas/lessons.get@1.input.json`.
- R4. **Validation.** `createManifest` validates the definition before it builds anything. Each failure is a fixed `GalaxieError('invalid', …)` without the offending value:
  - the ID, version and executor are non-empty strings;
  - every capability name is versioned and appears in only one group;
  - `entry` and every skill path start with `./`, contain no `..` segment, no backslash and no URL scheme, and are unique.
- R5. **Determinism.** Two calls with equal definitions return deep-equal results. Object keys follow the order R2 lists. Capability, model and schema maps are sorted by key with code-unit order.

**Build script (`scripts/build-manifest.ts`)**

- R6. The command is `node scripts/build-manifest.ts <packageDir> [--verify]`. It reads `<packageDir>/package.json`, whose `galaxie` field is `{ "definition": "./dist/index.js", "export": "tutorDefinition", "out": "./dist/galaxie" }`.
  - `definition` and `out` follow R4's path rules. `out` must resolve, through `realpath` of its existing parent, to a directory strictly inside the package directory and inside a `files` directory. The script checks this before it deletes or creates anything.
  - The CLI runs only when the module is the entry point (`import.meta.main`), so importing it from a test has no side effects. One test checks this.
  - It loads `@galaxie/core` resolved from the package directory with `createRequire(<packageDir>/package.json)`, and the definition module by file URL.
  - It fails when the definition's `version` differs from the package's `version`, so the two cannot drift.
- R7. **Writing.** The script writes `<out>/manifest.json` and every schema file under `<out>/schemas/`.
  - All JSON uses a single stable serializer: two-space indent, a trailing newline, keys in the order `createManifest` produced. The script removes and recreates `<out>` first, so stale files never remain.
  - The manifest's `integrity` field, added by the script, has three parts:
    - `entry`: the `sha256-<base64>` digest of the entry file;
    - `files`: a map from each package-relative path to its digest, sorted, with POSIX separators. It covers the shipped-file inventory: `package.json`, every file under the package's `files` entries except `<out>` itself, and every skill file. `<out>` is checked separately by R8. Generation and verification use the same inventory function.
    - `lockfile`: the digest of the nearest ancestor `pnpm-lock.yaml`.
  - A missing entry or skill file fails the run.
- R8. **Verification.** `--verify` recomputes every digest and the schemas. It exits non-zero and names the first mismatching path when any of these happens:
  - a file listed in `integrity.files` is missing, changed or new;
  - the entry or lockfile digest differs;
  - `manifest.json` or a schema file differs from what generation produces now.

  It writes nothing, and its messages hold paths only, never file contents.
- R9. The script exports `writeManifest(options)` and `verifyManifest(options)`. Both take the package directory, the loaded definition and `createManifest` as arguments, so tests run them without built `dist/` folders. The CLI path only does the loading.

**Wiring**

- R10. Add the `galaxie` field to `examples/english-tutor/package.json`. In the root `build` script, run `node scripts/build-manifest.ts examples/english-tutor && node scripts/build-manifest.ts examples/english-tutor --verify` right after the tutor's `tsc -p examples/english-tutor/tsconfig.build.json`.

**Tests**

- R11. Tests are split by what each tsconfig can resolve.
  - `tests/conformance/manifest.node.test.ts`, whose tsconfig already maps the tutor and core to source, checks that the tutor definition gives the expected manifest, compared with an inline expected object and not a snapshot file.
  - `packages/core/test/manifest.test.ts` covers:
  - `x-galaxie` labels and shapes in the generated schemas, using inline Zod schemas;
  - determinism;
  - every R4 rejection, and that the error message holds no offending value;
  - an unrepresentable schema fails `unsupported`. Use `z.date()` at the root and a nested `z.object({ at: z.date().optional() })`. A transform is representable on the input side, so it must not be the failing case.
  - a definition with an optional group and skills.
- R12. `scripts/test/build-manifest.node.test.ts`, or the nearest existing Node-project include path: if `scripts/test` is not included, place it under `tests/conformance/` or extend the include deliberately. It runs `writeManifest` and `verifyManifest` against a temporary fixture package with fixed entry and skill files, and checks:
  - byte-identical output across two runs;
  - exact digests for the fixture files;
  - stale-file removal;
  - verification passes on fresh output and fails, naming the path, after each of these: a dist file changes, a file is added, a file is removed, the lockfile changes, or a schema file is edited;
  - a version mismatch fails.

**Docs**

- R13. Update:
  - system design §13 or the agent-definition section, describing the manifest layout, the integrity fields, and what verification does and does not prove: a hash identifies provenance and integrity, not safe behavior (brief §9);
  - the AGENTS.md project status paragraph and the README status.

  The docs state the trust model:
  - digests prove only that a package matches the manifest being checked;
  - a host must obtain the manifest, or pin its digest, from a source it trusts, such as its own lockfile-resolved build output or a reviewed commit;
  - without signing (out of scope), an attacker who replaces both the package and the manifest passes verification;
  - the manifest's schemas omit custom refinements.

  Never describe the manifest as a sandbox or a security guarantee.

### Scope Boundaries

- No published CLI (ADR-0008); no signing; no runtime loading of packages by manifest.
- No browser-side verification API. Hosts verify at build or deploy time with `--verify`, or use Subresource Integrity with the listed digests.
- No change to the tutor's source or schemas.

### Assumptions

- Zod 4.6.7 schemas expose `~standard.jsonSchema.input`, as `readAnnotations` already relies on.
- Node 24 `node:crypto` provides SHA-256 and base64 output.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **A pure generator in core, I/O in a script.** Core owns the definition contract, so the generator lives in core and is tested with the source aliases. The script stays thin, and tests call it with injected inputs because CI runs tests before the build.
- KTD2. **Fail on unrepresentable schemas.** Runtime annotation reading may fall back to `any` and then label conservatively. A distributed manifest that understates a schema would mislead the host reviewing permissions.
- KTD3. **Integrity covers every shipped file plus the lockfile.** Hashing only the entry misses chunks and skills. The lockfile digest ties the build to its resolved dependency set.

### Output Structure

```text
packages/core/src/manifest.ts
packages/core/test/manifest.test.ts
tests/conformance/manifest.node.test.ts
scripts/build-manifest.ts
scripts/test/build-manifest.node.test.ts   (or the include path chosen in R12)
examples/english-tutor/package.json        (adds the galaxie field)
```

### Implementation Constraints

- New files carry the SPDX header. The compiler rules in AGENTS.md apply. `scripts/tsconfig.json` must type-check the new script under `tsc` and `tsc6`; extend its `include` deliberately if tests live under `scripts/test`.
- `scripts/build-manifest.ts` imports nothing from `@galaxie/core`, at type or value level, because `tsc -p scripts` runs before core's `dist/` exists.
  - It declares minimal local structural types, for example `type CreateManifest = (definition: unknown, options: { entry: string }) => { manifest: Record<string, unknown>; schemas: Readonly<Record<string, unknown>> }`.
  - It loads core at runtime with `createRequire(<packageDir>/package.json).resolve('@galaxie/core')` and `import(pathToFileURL(...))`.
  - It imports only `node:` modules, so it runs with plain `node` type stripping.
- Errors and messages never carry schema contents, file contents or digests of secrets. The script reads no environment variables.
- `check:deps` must still pass. Update it deliberately only if the script needs a rule.

## Implementation Units

- **U1. Generator.** R1–R5 and R11.
- **U2. Script.** R6–R9 and R12.
- **U3. Wiring.** R10, then confirm `pnpm build` produces `examples/english-tutor/dist/galaxie/manifest.json` and passes `--verify`.
- **U4. Docs.** R13.

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` | before the PR |
| Tutor source unchanged | `git diff --stat main -- examples/english-tutor/src` is empty. | before the PR |
| Protected paths | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr pnpm-lock.yaml` is empty. | before the PR |

## Definition of Done

- U1 to U4 are complete.
- `pnpm build` generates and verifies the tutor manifest.
- `pnpm check` and `CI=true pnpm test` pass, and GitHub CI is green.

## Appendix

### Sources

- Brief §13.2, §13.3, §16.6 and §9 (provenance versus safe behavior).
- ADR-0008.
- `packages/core/src/definition.ts` and `annotations.ts` (`readAnnotations`).
- `examples/english-tutor/src/definition.ts` and `schemas.ts`.
- `vitest.config.ts`, `scripts/tsconfig.json` and the root `package.json` scripts.
