# Browser-only projects

<!-- galaxie:cite path="templates/kinds/browser-only/files/README.md" heading="Route order and consent" sha256="0000000000000000000000000000000000000000000000000000000000000000" -->
<!-- galaxie:summary:start -->
Inference stays in the browser: available Built-in AI, otherwise an immediate
mock, with WebLLM only after explicit size-disclosed download consent. Keep the
mock active while loading; a dispatched call never retries on another provider.
Do not add a remote route without reviewing destination policy and consent.
<!-- galaxie:summary:end -->

<!-- galaxie:cite path="templates/kinds/browser-only/files/README.md" heading="Persistence and principal identity" sha256="0000000000000000000000000000000000000000000000000000000000000000" -->
Replace the demo principal with an opaque identity from the trusted sign-in
session before adding user data. Keep runtime, saver and recovery in the same
scope. Acquire ownership with the saver's fencing port before creating an
instance. Restore the saved session through the instance; dispose and apply the
host's invalidation/wipe policy on principal changes. Browser eviction can lose
checkpoints; pending drafts and model downloads are not durable history.

The selected framework may add build prerequisites: read its reference present
and the generated README. No real-device model performance is established by
mock tests. See the
[browser-only starter](https://github.com/vinhnxv/galaxie/blob/main/templates/kinds/browser-only/files/README.md).
