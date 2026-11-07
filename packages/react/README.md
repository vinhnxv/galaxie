# @galaxie/react

Typed agent surfaces and a separate host confirmation prompt. Agent components receive only `props`, `actions` and `status`; the host owns instance creation, preparation and disposal.

## Render outcomes and failures

`AgentSurface` reports a successful component mount through
`instance.recordRenderOutcome(outcome)` after commit. A class error boundary contains
registered component render failures so the surrounding host tree remains mounted.
Registry rejections report their fixed `unsupported`, `invalid` or `denied` code;
a component that throws reports `render_failed` with `The step could not be shown.`.
`onError(error)` receives that fixed `ErrorInfo` once per interaction and revision.
The thrown error object, message and stack are never passed to core, callbacks,
the DOM, events or spans. React itself may log caught errors in development.

Failures keep the run paused in `waiting_input`. Resuming on a failed render is not
supported yet. Hosts can supply `fallback(error, controls)`; the first argument is
unchanged, so existing one-argument fallbacks still work. The exported
`AgentSurfaceControls` exposes `cancel(): Promise<void>` for cancelling that run
before a host-owned Start over flow. Cancellation rejection propagates to the caller;
the host must handle it.

```tsx
<AgentSurface
  instance={instance}
  registry={registry}
  surfaceId="lesson-main"
  onError={(error) => showHostError(error.code)}
  fallback={(error, controls) => (
    <section>
      <p role="alert">{error.message}</p>
      <button type="button" onClick={() => { void controls.cancel().catch(showHostCancelError); }}>
        Cancel run
      </button>
    </section>
  )}
/>
```

Without a host fallback, failures show only `This step could not be shown.` in a
focusable `role="alert"` paragraph. Focus moves to it once, including under Strict
Mode. A new instance, run, interaction or view revision resets the boundary.
The surface owns no automatic retry, resume or instance lifecycle.

The journaled `render` event contains only runtime event identity, interaction ID,
view revision, status (`rendered` or `failed`) and a fixed failure code. It contains
no props, model text or user content. Duplicate reports and stale identities are
ignored by core; `rendered` may be followed by `failed`, after which reports for
that interaction revision are ignored. Each recorded outcome also becomes a short
`galaxie.render` span under the paused segment's run span, carrying only
`galaxie.render.status` and, for failure, `galaxie.render.error.code`.
See [tracing](../../docs/guides/tracing.md).

## Education components

`educationComponents` includes headless `Quiz`, `WritingPrompt`, `Feedback` and `Progress` entries. Quiz uses native radio groups with fieldsets and legends; WritingPrompt uses a labelled textarea. Their named submit buttons work by keyboard. Inputs and submit buttons are disabled while submitting or accepted; Tab can still leave the form.

Quiz and WritingPrompt show one `role="alert"` when `status` is `{ rejected: code }`, and link the submit button to it with `aria-describedby`. Rejection re-enables inputs and preserves the selection or draft for retry. The messages are fixed English, selected only by the error code:

| Code | Message |
| --- | --- |
| `invalid` | Check your answer and try again. |
| `duplicate` | This answer was already sent. |
| `stale` | This question is no longer active. |
| All other codes | Your answer could not be sent. Try again. |

Dispatch status does not identify an invalid field, so focus moves to the alert when an already-mounted component enters rejection. Initial render never moves focus, even with a rejected status, and rerenders or code changes within rejection do not move it again. The alert sits immediately before submit: Tab reaches that button for retry. Any later `idle`, `submitting` or `accepted` status removes the alert and its description link.

Hosts may wrap these reference components to provide their own language or presentation; no i18n configuration is provided. Alert messages never include model text, props or drafts. Model-produced props remain React text. [Chromium accessibility tests](../../tests/conformance/education-a11y.test.tsx) cover keyboard completion, labels, rejection, focus and retry through the surface with a fake instance; no model is called. These checks do not constitute an accessibility audit or assistive-technology testing.

## Model destinations

Mount the headless `ModelRoutes` beside the host's run status:

```tsx
import { ModelRoutes } from '@galaxie/react';

<ModelRoutes
  instance={instance}
  labels={{
    roles: { 'quiz.generate': 'Quiz', 'tutor.feedback': 'Feedback' },
    providers: { quiz: 'Site quiz service', feedback: 'Browser feedback' },
  }}
  destinationLabels={{ 'in-browser': 'In this browser' }}
/>;
```

It subscribes through `useAgentSnapshot(instance)` and lists each selected role in snapshot order as `<role>: <provider> (<destination>)`. Optional `labels.roles` and `labels.providers` are trusted host text; missing labels fall back to the snapshot's host-defined IDs. Default destination labels are `In browser`, `User device`, `User endpoint`, `Host server` and `Third party`. Optional `destinationLabels` overrides individual classes, including in the visible `changed from <previous destination>` notice required by ADR-0006.

The `aria-live="polite"` container stays mounted before the first selection; the named `Model destinations` list appears only when routes exist. It has no `role="status"`, leaving the host's run status separate. All labels and identifiers render as React text; the component reads no model output, controls no consent and owns no instance lifecycle. Routes are per instance, not persisted: a restored session shows a role only after its next routed call. See [the model-call contract](../../docs/system-design.md#84-a-model-call) and [component tests](test/model-routes.test.tsx).

## Capability confirmations

Register fixed host text and derive rows from the capability's validated arguments. Mount `ConfirmationPrompt` in the host tree, outside `AgentSurface` and the agent component registry.

```tsx
import { AgentSurface, ConfirmationPrompt, defineConfirmations } from '@galaxie/react';

const confirmations = defineConfirmations({
  'progress.save@1': {
    title: 'Save progress',
    fields: (args) => [
      { label: 'Lesson', value: (args as { lessonId: string }).lessonId },
    ],
    approveLabel: 'Save', // Defaults: Allow and Cancel.
  },
});

const instance = await runtime.create(definition, {
  principalScope,
  agent,
  bindings,
  ui: registry.bindings({ surfaces: ['lesson-main'] }),
  confirmations: {
    capabilities: confirmations.capabilities,
    policyRevision: () => hostPolicyRevision,
    expiresInMs: 120000,
    signals: [logout.signal, ownership.signal],
  },
});

// The host also disposes the instance on logout and ownership loss.
const dispose = (): void => { void instance.dispose(); };
for (const signal of [logout.signal, ownership.signal]) {
  signal.addEventListener('abort', dispose, { once: true });
  if (signal.aborted) dispose();
}

// After host-owned preparation and start:
<>
  <AgentSurface instance={instance} registry={registry} surfaceId="lesson-main" />
  <ConfirmationPrompt instance={instance} confirmations={confirmations} />
</>;
```

`defineConfirmations` validates entry shapes and freezes its entries and capability list. `entry(name)` returns the host entry or `undefined`. Titles, labels and button text come from the host; row values render as React text, including strings that resemble HTML. If rows throw, have an invalid shape or lack an entry, the prompt shows only “This action cannot be shown.” and a decline button. It never approves during render and owns no instance lifecycle.

Core checks coverage for every bound `approval: 'confirm'` capability at creation. Unknown registry names are allowed, so a registry can serve several agents. Without confirmation configuration, `confirm` calls still fail `unsupported`. `policyRevision()` must return a non-empty string of at most 128 characters; invalid values or exceptions fail `unavailable`. Keep it synchronized with the host's grants and binding policy. Expiry defaults to 120000 ms and must be a safe integer from 1000 to 600000.

Pending entries appear only in the in-page `snapshot.confirmations` list. The synchronous host API `instance.respond(id, 'approve' | 'decline')` returns `approved`, `declined` or `stale` in its `status` field and never throws. Core binds a single dispatch to the principal, capability, frozen canonical arguments, effect ID, policy revision and expiry. An argument object's later mutation cannot alter the approved copy. Policy changes, expiry and configured signals invalidate unused approvals, including while waiting for a concurrency slot. The binding timeout starts after approval; run cancellation and wall-clock limits also bound waiting.

Approvals live only in page memory, so a reload asks again. Successful recovery receipts replay without approval because they make no new effect. Same-origin page scripts can call `respond`: this protects against model-controlled content, not page scripts. Hosts must dispose instances on logout and takeover and should pass both signals. Backends must still authorize every write from trusted context (ADR-0012 B1). An expired or declined approval does not undo a request already sent. Keep arguments and IDs out of agent props, logs and exported diagnostics; the existing opt-in development argument tracing and host-only binding-error diagnostic rules are documented in the [broker contract](../../docs/system-design.md#83-a-capability-call).
