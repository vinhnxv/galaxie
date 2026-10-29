---
title: M2 English Tutor Agent Package - Plan
type: feat
date: 2026-10-29
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# M2 English Tutor Agent Package - Plan

## Goal Capsule

- **Objective:** The MVP tutor of brief §4.2, steps 1 to 10, runs as a reusable agent package on galaxie with mock providers. The flow:
  1. load a lesson through a host capability;
  2. generate a schema-valid quiz;
  3. commit the quiz and its answer key before the Quiz interrupt;
  4. grade deterministically from the committed key;
  5. take one free-text learner sentence;
  6. review it with `tutor.feedback`;
  7. show Feedback;
  8. save progress through a capability;
  9. show Progress.

  The learner's sentence is labelled `private-user`, so with the default data policy only an `in-browser` provider can review it. The answer key never reaches interaction props or the run output.
- **Means:**
  - **Core:** a dispatch accepted with UI bindings adds the data labels declared in that action's payload schema to the run's sticky labels. Today a submitted payload only labels traces (system design §6).
  - **`packages/react`:** the reference component `education.WritingPrompt/v1`. Its payload field is annotated `private-user` free text.
  - **New workspace package `examples/english-tutor`** (`@galaxie/example-english-tutor`, private), holding:
    - the agent definition;
    - a LangGraph graph factory that uses only host-bound capabilities and routed model roles;
    - a public output projection.
- **Authority, highest first:**
  1. `AGENTS.md` repository rules.
  2. Accepted ADRs in `docs/adr/`, in particular ADR-0002, ADR-0004, ADR-0006, ADR-0008, ADR-0012, ADR-0014, ADR-0016 and ADR-0017, plus ADR-0007 as the Proposed working default. Do not edit any ADR.
  3. This plan.
  4. `docs/galaxie-project-brief.md` §3.3, §4.2, §4.3, §9.7 C, §12.2 and §16.4.
  5. `docs/system-design.md` §4 to §6.
  6. `spikes/c-ui-path/README.md`, as evidence only. Never import or copy spike code.

  When this plan and an Accepted ADR disagree, follow the ADR and record the conflict in the PR body.
- **Execution profile:** autonomous, in Node and headless Chromium only. Work on the existing branch `m2/english-tutor` and open one pull request against `main`. Run the units in order, U1 to U7, and run `pnpm check` after each one.
- **Stop conditions:** stop and open a draft pull request that names the blocker when any of these happens:
  - a requirement can pass only by weakening an ADR-0012 guarantee, or by putting lesson, quiz, answer, sentence or reply text in an error, diagnostic, span or snapshot;
  - an existing test assertion must change, other than the one U2 names;
  - a conformance golden or the compatibility matrix would change;
  - a dependency would be added at a version not already in `pnpm-lock.yaml`, or any dependency would be upgraded or removed;
  - `pnpm check` still fails after three focused fix attempts on the same cause.
- **Who finishes:** the implementing agent opens the pull request and stops. It never merges, never pushes to `main` and never enables auto-merge.

---

## Product Contract

### Summary

The tutor is the M2 vertical slice's agent. It proves three things together:
- an agent package can be written against galaxie's contracts alone;
- the answer key can stay out of display data;
- a learner's free text is kept on the device by labels rather than by the agent's goodwill.

The core change closes the gap system design §6 records: "This trace-only rule does not label UI payloads for model routing; those schemas arrive with the M2 registry."

### Problem Frame

- **No routing label on submissions.** A sentence submitted through `dispatch` labels traces only, not model routing, so a host route could send it to a remote class.
- **Graph state is not display data.** The adapter journals the last `values` chunk as the run output. If the state holds the grading key, so does the output (Spike C finding).
- **No component for free text.** The M2 registry has no reference component that collects a free-text answer.
- **Model calls re-run on resume.** A model call in the same node as an interrupt runs again on resume, which would regenerate the quiz (brief §12.2).

### Requirements

**Core: labels from bound payload schemas**

- R1. When `CreateOptions.ui` is given and `dispatch` accepts a submission, core adds `readAnnotations(payloadSchema).labels` in full to the run's sticky labels, including the implicit `app` that unannotated leaves carry, as for capability schemas. Core also registers `privateStrings(payload)` with the run's private values, as it does for run input, so the verbatim guard covers the sentence. This happens before the resume segment starts, so the resumed segment's model and capability calls see them. The trace decision is refreshed with them in the same place as other label changes (`labelsChanged`).
  - A payload schema without Standard JSON Schema, or one `readAnnotations` rejects, makes core add `private-user` whenever the payload contains a non-empty string. This is the conservative default; it never drops a label.
  - Without `ui`, behavior is unchanged (M1).
  - Labels never come from the payload's values, only from the host-trusted schema.
  - The snapshot's sorted `labels` show the new label after acceptance.

**React: free-text reference component**

- R2. `packages/react` adds `education.WritingPrompt/v1`, exported as `WritingPrompt`, and adds it to `educationComponents`. It is headless, like the others. It has:
  - props `{ title?, prompt, placeholder?, maxLength? }`, where `prompt` is `longTextSchema`, `title` and `placeholder` are `shortTextSchema`, and `maxLength` is an integer from 1 to 500 (default 500);
  - one action `submit` labelled `Submit sentence`, with payload `z.strictObject({ sentence: z.string().trim().min(1).max(500).meta(galaxieField({ label: 'private-user', shape: 'freeText' })) })`;
  - a `textarea` and a submit button that is disabled while the trimmed draft is empty or the status is `submitting`.

  Model text renders as React text only. The draft stays component-local, as with the other components.

**Agent package**

- R3. `examples/english-tutor` is a private workspace package, `@galaxie/example-english-tutor`. It is ESM, has `sideEffects: false`, has the SPDX headers, and builds with the strict settings.
  - Its source imports only `@galaxie/core`, `@galaxie/adapter-langgraph`, `@langchain/langgraph/web`, `@langchain/core/*`, `zod` and relative files.
  - It never calls `fetch`, storage, the DOM, timers for I/O or `eval`, and never contains a URL, token, tenant ID or database connection (brief §4.3, §9.7 C).
  - `check:deps` enforces the import list.
- R4. `tutorDefinition` is built with `defineAgentDefinition`:
  - `id: 'galaxie.english-tutor'`, `version: '0.0.0'`, `executor: 'langgraph-js'`;
  - `input: z.strictObject({ lessonId: <id schema with shape 'id'> })`;
  - required capabilities:
    - `lessons.get@1` (kind `read`): input `{ lessonId }`; output a lesson with `id`, `title`, `grammarPoint`, `content` (free text, max 4000) and `rubric` (free text, max 2000);
    - `progress.save@1` (kind `write`): input `{ lessonId, score, total }` (integers, `0 <= score <= total <= 20`); output `{ saved: true }`;
  - model roles:
    - `quiz.generate`: `{ modality: 'text', requires: ['structured-output'], languages: ['en'] }`;
    - `tutor.feedback`: `{ modality: 'text', requires: ['structured-output'], languages: ['en'], defaultPolicy: 'local-only' }`;
  - `ui: { catalog: 'education/v1', components: ['Quiz', 'WritingPrompt', 'Feedback', 'Progress'], surfaces: ['lesson-main'] }`.

  Hosts get type-checked bindings through `BindingsFor<typeof tutorDefinition>`.
- R5. `createTutorAgent(): LangGraphAgent` builds a `StateGraph` with an explicit input schema and output schema. The state keeps `lesson`, `quiz` (questions with option IDs), `answerKey`, `answers`, `score`, `sentence`, `review` and `saved`. The output channels hold only `{ lessonId, score, total, saved }`, so the journaled run output never contains the key, the quiz, the sentence or the review (Spike C).
  - The graph uses `host.capabilities.call`, `host.langchain.chatModel(role)` and `host.langchain.checkpointer()` only.
  - Every node that interrupts does nothing before `requestInteraction` that a re-execution would repeat (brief §12.2). It passes the node's `config` explicitly.
- R6. Nodes, in order:
  1. `loadLesson`: calls `lessons.get@1`.
  2. `generateQuiz`: calls `quiz.generate` with `withStructuredOutput(QuizDraftSchema)`. `QuizDraftSchema` is a Zod schema of 3 to 5 questions, each with 3 or 4 options and a `correctOptionId`. The node validates that every `correctOptionId` names one of that question's options, and rejects with `GalaxieError('invalid', 'The generated quiz is invalid.')` otherwise. It assigns stable IDs (`q1`…, `a`…) in code, not from the model, then commits `quiz` and `answerKey` to state.
  3. `askQuiz`: `requestInteraction` with component `education.Quiz/v1` on surface `lesson-main`. Its props are the quiz without `correctOptionId`, built from state. It stores `answers`.
  4. `grade`: pure deterministic code computes `score` from `answers` and `answerKey`. A missing or unknown answer counts as wrong. No model call.
  5. `askSentence`: `requestInteraction` with `education.WritingPrompt/v1`, whose prompt asks for one sentence applying `lesson.grammarPoint`. It stores `sentence`.
  6. `reviewSentence`: calls `tutor.feedback` with `withStructuredOutput(ReviewSchema)`, where `ReviewSchema` is `{ verdict: 'correct' | 'needs_work', comments: string[1..3], each ≤ 300 }`. The input is the rubric, the grammar point and the sentence.
  7. `showFeedback`: `requestInteraction` with `education.Feedback/v1`. Its items are one item per question (`correct` or `incorrect`, text built in code from the prompt and the correct option label), then the review comments as `info` items. All IDs are built in code. It continues on `continue`.
  8. `saveProgress`: calls `progress.save@1` with `{ lessonId, score, total }` after the Feedback interrupt, so the write follows a confirmation step (brief §9.7 C).
  9. `showProgress`: `requestInteraction` with `education.Progress/v1`, `{ label: lesson.title, current: score, total }`. It continues on `continue`, then the graph ends.
- R7. Exports from `examples/english-tutor/src/index.ts`: `tutorDefinition`, `createTutorAgent`, the capability and model I/O schemas, and `lessonFixture`. `lessonFixture` is a small built-in lesson (`id: 'present-simple-1'`, the English present simple) so hosts and tests can bind `lessons.get@1` locally (brief §4.3, Host A).

**Tests and documentation**

- R8. Tests run with `@galaxie/models`' mock provider on Node and Chromium. No network, no weights, no real `LanguageModel`.
- R9. Docs: system design §6 replaces the sentence quoted above with R1's rule. System design §4 adds the example package and WritingPrompt. The AGENTS.md project status paragraph and the README status describe what ships and its limits:
  - grading is local practice only (brief §4.2);
  - `stream` events carry raw graph state, answer key included, so hosts must not render them as display data;
  - the projection covers the run output and interaction props only;
  - **Host contract:**
    - The checkpointer holds the sentence and the answer key, so for this agent it must stay on the device and be scoped to the learner and session. The default in-memory saver does.
    - The `progress.save@1` binding must take the learner from trusted host context, never from the agent's arguments, and must authorize that learner for the lesson before writing. The agent sends only `{ lessonId, score, total }`.

### Scope Boundaries

- **Deferred to slice 7:** the example host app, CSP and the Playwright network capture (AT-04).
- **Deferred to M3:** reload restore (step 11) and draft persistence.
- **Deferred to the real-device exit slice:** real providers and real devices.
- **Not done here:** LLM-generated explanations of mistakes (step 8's optional explanation). Feedback text for quiz items is built in code.
- **Not done here:** a grammar rubric quality evaluation. galaxie does not score answer quality.
- **No changes to:** the router, the output safety hook, the WebLLM and Built-in AI providers, ADRs, goldens or the compatibility matrix.

### Assumptions

- LangGraph 1.5.1's `StateGraph` output schema restricts the root `values` stream to the output channels. U5 verifies this with a test. If it does not hold, the graph adds a final projection node that writes only the output keys, and U5 asserts the journaled output instead.
- The mock provider can be scripted to return the JSON replies the structured-output calls need. Tests drive it through its existing script API.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Labels come from the host's schema, never from the payload.** The registry entry, trusted host code, declares that a sentence is `private-user`. A model-chosen prop cannot remove that label.
- KTD2. **Fail toward labelling.** If a schema cannot be read, any text in the payload makes the run `private-user`, which can only narrow destinations.
- KTD3. **Model calls get their own nodes.** Each model call is in its own node, before or after an interrupt node, and never in the interrupt node itself. A resumed interrupt node re-runs only cheap, deterministic code.
- KTD4. **IDs and display text for grading are built in code.** The model never chooses an interaction ID, an option ID or a correctness flag shown to the learner.
- KTD5. **The output schema is the projection.** Using LangGraph's own output channels keeps the projection inside the graph package, where the author knows which fields are public.

### High-Level Technical Design

```mermaid
flowchart LR
  A[loadLesson\nlessons.get@1] --> B[generateQuiz\nquiz.generate]
  B --> C[askQuiz\ninterrupt Quiz]
  C --> D[grade\ndeterministic]
  D --> E[askSentence\ninterrupt WritingPrompt]
  E -->|dispatch: run gains private-user| F[reviewSentence\ntutor.feedback]
  F --> G[showFeedback\ninterrupt Feedback]
  G --> H[saveProgress\nprogress.save@1]
  H --> I[showProgress\ninterrupt Progress]
  I --> J((end: lessonId, score, total, saved))
```

### Output Structure

- `packages/core/src/agent-instance.ts`, plus tests in `packages/core/test/`.
- `packages/react/src/components/writing-prompt.tsx`, `packages/react/src/components/index.ts`, `packages/react/src/index.ts`, `packages/react/test/components.test.tsx`.
- `examples/english-tutor/{package.json,tsconfig.json,tsconfig.build.json,src/*.ts,test/*.test.ts,test/tsconfig.json}`.
- `pnpm-workspace.yaml` (adds `examples/*`), root `package.json` scripts, `vitest.config.ts`, `pnpm-lock.yaml`, `scripts/check-dependencies.ts`, `scripts/check-license.ts` (only if it does not already scan `examples/`), and `biome.json` (only if it excludes `examples/`).
- `tests/conformance/english-tutor.test.tsx`, `tests/conformance/package.json`, `tests/conformance/tsconfig.json`.
- Docs: `docs/system-design.md`, `AGENTS.md`, `README.md`.

The tree is a scope declaration; the per-unit file lists are authoritative.

### Implementation Constraints

- New source files start with the SPDX header from ADR-0015. Relative imports end in `.js`, type-only imports use `import type`, exported functions declare return types, and there is no `enum`.
- Dependencies of `@galaxie/example-english-tutor`:
  - `dependencies`: `@galaxie/core` and `@galaxie/adapter-langgraph` (`workspace:*`);
  - `peerDependencies`: `@langchain/core` `~1.2.20`, `@langchain/langgraph` `~1.5.1` and `zod` `^4.6.0`;
  - `devDependencies`: the exact versions already in the lockfile (`@langchain/core` 1.2.20, `@langchain/langgraph` 1.5.1, `zod` 4.6.7), plus `@galaxie/models` `workspace:*` for tests;
  - `tests/conformance` adds `@galaxie/example-english-tutor: workspace:*`.

  No new external package versions.
- Errors are `GalaxieError` values with fixed messages and no `cause`.

---

## Implementation Units

### U1. Core: labels from bound payload schemas

- **Files:** `packages/core/src/agent-instance.ts`, `packages/core/src/annotations.ts` (widen `readAnnotations`' parameter to accept `StandardSchema`, since it reads only `~standard.jsonSchema` at runtime), `packages/core/src/index.ts` (export `readAnnotations` and `type Annotations`), `packages/core/src/interactions.ts` (only if a helper belongs there), `packages/core/test/ui-labels.test.ts`.
- **Approach:** implement R1 at the point where `dispatch` records the accepted entry (next to `submittedText`). Cache the annotations per payload schema, for example in a `WeakMap`, so each accepted dispatch does not re-read the schema. Reuse `readAnnotations`; do not add a second annotation reader.
- **Test scenarios:**
  - With bindings whose `submit` payload marks `sentence` as `private-user`, an accepted dispatch makes `snapshot.run.labels` include `private-user`. A routed role whose only provider is `host-server` is then refused (`denied`) in the resumed segment, while an `in-browser` provider is selected. A capability call to a `host-server` binding whose free-text argument repeats the sentence is refused by the verbatim guard.
  - A payload schema with no explicit labels adds only `app`, shown with a run whose input labels were only `public`.
  - A Standard Schema without `jsonSchema`, given a payload with a non-empty string, adds `private-user`; given only numbers, adds nothing.
  - A rejected dispatch (invalid, stale, duplicate) changes no labels.
  - Without `ui`, labels after dispatch are as in M1.
  - No label is ever removed.

### U2. React: WritingPrompt

- **Files:** `packages/react/src/components/writing-prompt.tsx`, `packages/react/src/components/index.ts`, `packages/react/src/index.ts`, `packages/react/test/components.test.tsx`. New tests, plus one permitted assertion change: the existing test 'education entries expose one catalog and answer actions' gains `education.WritingPrompt/v1` and a length of 4. List that change in the PR body.
- **Test scenarios:**
  - It renders the prompt as text, and markup in the prompt stays text.
  - Submit is disabled for an empty or whitespace draft.
  - Submitting dispatches `{ sentence }` once.
  - A 501-character sentence resolves `invalid` without dispatch.
  - `registry.bindings()` includes `education.WritingPrompt/v1` with its payload schema, and `readAnnotations` on that schema reports `private-user`.

### U3. Package scaffold

- **Files:** `pnpm-workspace.yaml`, `examples/english-tutor/package.json`, `examples/english-tutor/tsconfig.json`, `examples/english-tutor/tsconfig.build.json`, `examples/english-tutor/test/tsconfig.json`, root `package.json` (the typecheck, typecheck:ts6 and build scripts), `vitest.config.ts` (add `examples/*/test/**/*.test.ts` to the Node project, and `../../examples/*/test/**/*.test.ts` to the Chromium project with `../../examples/*/test/**/*.node.test.ts` excluded; add `@galaxie/example-english-tutor` to the shared `alias` map pointing at `examples/english-tutor/src/index.ts`, and to `optimizeDeps` if needed), `pnpm-lock.yaml`, `scripts/check-dependencies.ts`, `tests/conformance/package.json`, `tests/conformance/tsconfig.json` (a `paths` entry for the example).
- **Approach:** follow `packages/adapter-langgraph`'s layout. Extend `check:deps`:
  - R3's import allowlist for `examples/english-tutor/src` and its `dist`;
  - no `react` or `react-dom` in the example;
  - no `@galaxie/models` in the example's source.

### U4. Definition and schemas

- **Files:** `examples/english-tutor/src/definition.ts`, `examples/english-tutor/src/schemas.ts`, `examples/english-tutor/src/lesson-fixture.ts`, `examples/english-tutor/test/definition.test.ts`.
- **Test scenarios:**
  - A host binding object missing `progress.save@1` fails to compile. Use a `@ts-expect-error` line in a type test.
  - `lessonFixture` passes the `lessons.get@1` output schema.
  - The lesson `content` and `rubric` fields are free text, and `lessonId` has shape `id`, as `readAnnotations` reports.
  - The definition's `ui` requirements are met by `registry.bindings` built from `educationComponents`. This last check lives in U6, because the example must not import React.

### U5. Graph

- **Files:** `examples/english-tutor/src/graph.ts`, `examples/english-tutor/src/index.ts`, `examples/english-tutor/test/graph.test.ts`.
- **Approach:** implement R5 and R6. Prompts are short English constants in `graph.ts`. Feedback item text is built from the lesson and quiz data.
- **Test scenarios:** use `createRuntime` with `createLangGraphAdapter()`, the mock provider routed as `in-browser` for both roles, fixture bindings and core `UiBindings` built in the test. Each `UiBindings` entry declares a payload schema equivalent to the reference components', with the sentence annotated `private-user`.
  - **Happy path:** the run pauses on Quiz. The props have no `correctOptionId` anywhere, and the serialized props do not contain any answer-key value paired with its question. Dispatching answers with 2 of 3 correct leads to WritingPrompt. The sentence leads to Feedback, whose items mark exactly the incorrect question. `continue` leads to Progress with `current: 2, total: 3`. `continue` succeeds with output exactly `{ lessonId, score: 2, total: 3, saved: true }`.
  - **Quiz not regenerated:** the mock records exactly one `quiz.generate` call across the whole run, including the resumes.
  - **Grading:** a missing answer and an unknown option ID both count as wrong, and grading uses the committed key even if the dispatched payload names other option IDs.
  - **Invalid quiz:** a quiz draft whose `correctOptionId` is not among its options fails the run with `invalid`.
  - **Order:** `progress.save@1` is called once, after the Feedback `continue`, with `{ lessonId, score, total }`, and never before.
  - **Labels:** after the sentence is dispatched, `snapshot.run.labels` includes `private-user`. With `tutor.feedback` routed only to a `host-server` mock, the run fails at `reviewSentence` with `denied`, and that provider is never called.
  - **No text leaks:** use a sentinel sentence and assert it is absent from every error, diagnostic and span attribute in the run. The run's `stream` events are excluded, as R9 documents.
  - **No hardcoded endpoints or ambient I/O** (in `examples/english-tutor/test/source.node.test.ts`, Node only): a source scan test asserts that `examples/english-tutor/src` contains none of `http://`, `https://`, `fetch(`, `XMLHttpRequest`, `WebSocket`, `localStorage`, `sessionStorage`, `indexedDB`, `document.`, `window.`, `navigator.`, `setTimeout(`, `setInterval(`, `eval(` or `new Function(`.

### U6. Conformance: tutor with the React registry

- **Files:** `tests/conformance/english-tutor.test.tsx`. It is Chromium only, since the browser project runs `.tsx` files and `@galaxie/react` needs JSX; Node coverage comes from U5.
- **Approach:** run the U5 happy path using `createRegistry({ components: educationComponents }).bindings({ surfaces: ['lesson-main'] })` as `ui`. Each pending interaction must pass `registry.resolve(pending)` with `ok: true`, so the agent's props fit the real reference schemas. Do not render React here; resolution is enough.
- **Test scenarios:**
  - The full run in Chromium.
  - `create` succeeds with these bindings and rejects with `unsupported` when `WritingPrompt` is left out.

### U7. Documentation

- **Files:** `docs/system-design.md`, `AGENTS.md`, `README.md`.
- **Approach:** R9, in the style of the surrounding sections. Describe controls and limits, never claims of safety.

---

## Verification Contract

| Gate | Command or check | Applies to |
| --- | --- | --- |
| Full local CI | `pnpm check` | every unit |
| CI-mode tests | `CI=true pnpm test` (Node and headless Chromium) | U2 and later, and before the PR |
| M1 behavior kept | every pre-existing test passes with unchanged assertions | every unit |
| Goldens unchanged | `git diff --stat main -- tests/conformance/golden tests/conformance/compatibility-matrix.json docs/adr` is empty | before the PR |
| Dependencies | the lockfile diff adds only importer entries for `examples/english-tutor` and the `tests/conformance` link; every resolved version already exists, and the `packages:` and `snapshots:` sections are unchanged; `pnpm install --frozen-lockfile` passes | U3, before the PR |

---

## Definition of Done

- U1 to U7 are complete, and each unit's test scenarios exist and pass.
- `pnpm check` and `CI=true pnpm test` pass on the final commit.
- The answer key is absent from interaction props and run output, and tests show it.
- An accepted sentence labels the run `private-user` before `tutor.feedback` runs, and tests show it.
- The goldens, the compatibility matrix and `docs/adr/` are unchanged.
- The PR body lists the Scope Boundaries deferrals and the documented limits.

---

## Appendix

### Sources

- Brief §3.3, §4.2, §4.3, §9.7 C, §12.2, §16.4; ADR-0004, ADR-0007, ADR-0008, ADR-0014.
- `docs/system-design.md` §6 (the trace-only submission label sentence).
- `spikes/c-ui-path/README.md`, "Findings for M2" (output projection).
- `packages/core/src/agent-instance.ts` (`dispatch`, `submittedText`, `labelsChanged`), `packages/core/src/annotations.ts` (`readAnnotations`), `packages/core/src/definition.ts`, `packages/core/src/policy.ts` (`galaxieField`, `DEFAULT_DATA_POLICY`).
- `packages/adapter-langgraph/src/adapter.ts` (the root `values` chunk becomes the output), `packages/adapter-langgraph/src/interaction.ts` (`requestInteraction`), `packages/adapter-langgraph/src/host.ts`.
- `packages/react/src/components/*.tsx` (reference schemas), `packages/models/src/mock.ts`.
