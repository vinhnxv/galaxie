# M3 exit record

Date: 2026-10-29. Device: Apple M5 Pro, macOS, Chrome 155.0.8059.86. These are demonstrations on one device (brief §18), not pass/fail gates. The guarantees are checked by the automated tests listed below.

## What ran

The default-mode build of `examples/host-local` was served with `vite preview` on `http://127.0.0.1:4173`, with its CSP header. The maintainer's Chrome was driven through browser automation, with real models and IndexedDB recovery. The quiz came from the real generation role, so a regenerated quiz would differ from the first.

| Step | What was done | Observed |
| --- | --- | --- |
| Reload while waiting on the quiz | The quiz text was recorded, the page reloaded, then **Prepare models** | The restored quiz matched the recorded text character for character (828 characters), with no new generation call. The run stayed `waiting_input`, with no alert. |
| Double submit of the quiz | Two `click()` calls on **Submit answers** in the same task | One inbox entry for the interaction, then `consumed`. The run moved to the writing prompt once. |
| Reload while waiting on the writing prompt | Reload, then **Prepare models** | The writing prompt was restored. |
| Double submit of the sentence and of Feedback | Two `click()` calls on **Submit sentence** and on **Continue** | Three interactions, three inbox entries, all `consumed`. One `progress.save@1` journal record, `succeeded`. The run ended `succeeded` with a score of 5/5, and the session key was removed. |
| Second tab | A second tab prepared and pressed **Start**, then **Use here** | The second tab first showed "The lesson is active in another tab.". After **Use here**, the first tab showed "The lesson moved to another tab." with input disabled, and the second tab generated a new quiz. |
| Sign out from the tab that lost ownership | **Sign out** in the first tab | Both tabs showed "Signed out. Reload to continue.". Afterward the database held no checkpoint, write, inbox or journal record. `meta` held three records: the schema record, the principal generation and the app epoch. |
| Reload right after submitting a quiz | **Submit answers**, then a reload 150 ms later, then **Prepare models** | The writing prompt was restored, and the quiz's inbox entry was `consumed` before and after. Deterministic grading finished before the reload, so this run did not land inside the accept-to-consume window. That window is covered by the fault-injection tests below. |

## Acceptance tests

Automated evidence runs in CI on Node and headless Chromium, with mock providers.

- **AT-08, durable quiz.**
  - `tests/conformance/restore.test.ts` restores every interrupt golden, including subgraphs, from a reopened IndexedDB saver.
  - The host loop in `examples/host-local/test/loop.node.test.ts` reloads on the quiz and the writing prompt.
  - The real run above restored the same model-generated quiz.
- **AT-09, duplicate submit.**
  - The inbox rejects a second submission for an interaction with `duplicate`, before and after consumption and across a reload (`tests/conformance/recovery.test.ts`: "restores an unaccepted interrupt and rejects a double click after reload", "keeps the duplicate receipt after consumption and a reload").
  - The real run saved progress once despite double clicks.
- **AT-31, submission crash windows.** `tests/conformance/recovery.test.ts` injects a crash at each boundary under each durability mode:
  - before the resume;
  - after the resume checkpoint;
  - before the resume checkpoint after a succeeded write;
  - with a dispatched write under `retry: 'none'` and `'idempotency-key'`;
  - after reopening the IndexedDB inbox and journal.

  An accepted answer resumes exactly once, a succeeded write is reused, and an unknown `retry: 'none'` write fails `outcome_unknown` without repeating.
- **AT-18, multi-tab.** `tests/conformance/ownership.test.ts` covers:
  - a forced takeover in the middle of a run: every former-owner result is refused, and the unknown remote outcome is preserved;
  - a cooperative handover that reuses the effect ID and commits one remote effect;
  - a `pageshow` check that notices another connection's claim.

  The real run showed the handover in two tabs.
- **AT-13 and the logout part of AT-34.** `tests/conformance/invalidation.test.ts` wipes a paused graph and rejects late writes, with and without delivery of the cross-tab notice. The real run signed out from a non-owner tab.
- **AT-34, storage lifecycle.** The storage package tests and `tests/conformance/lifecycle.test.ts` cover the following, each with its typed outcome:
  - retention;
  - a blocked or superseded upgrade;
  - a newer schema;
  - corruption;
  - quota;
  - an incompatible agent version.

## Not measured

- A browser or renderer crash. The real run used reloads, and crash windows were exercised only through fault injection.
- The accept-to-consume window with a real model. Grading is deterministic and finished before the reload.
- A forced takeover with real models, and a `pageshow` restore from the real back/forward cache. Both are covered with synthetic events and mocks only.
- Restore latency, and storage size after a lesson.

## Observations

- In the real run, **Start** in a tab whose lesson had already succeeded did not start a new lesson. The tab kept ownership, so the second tab reported "active in another tab" until **Use here**.
- Drafts still reset on reload, as M3 scoped.

## Mocked or not yet done

- **Mocked:** every CI test of recovery, ownership and logout uses mock providers.
- **Not yet done:**
  - the external developer trial, an M3 exit condition, is a maintainer task and is still open;
  - remote providers, MCP and confirmations with approval invalidation are M4 work.
