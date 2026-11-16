---
name: galaxie
description: Build or change browser agents in apps using galaxie. Preserve host-owned routing, capability policy, confirmations and UI while following the installed framework's supported shapes and refusals.
version: 0.1.0
---

# Build with galaxie

Before editing, compare this skill's `version` with the app's installed
`@galaxie-ai/core` version in `node_modules/@galaxie-ai/core/package.json`.
Stop on a mismatch and obtain matching guidance; do not guess compatibility.
Read the references present in this skill's `references/` directory for the
project's kind and framework. An existing app may have several; follow only the
ones matching its actual host and executor. Read
[host integration](references/host-integration.md) when changing host wiring.

## Baseline to preserve

<!-- galaxie:cite path="docs/adr/0012-security-baseline.md" heading="Decision" sha256="a92d75c3ffb3f5b696b8b7637d3e0ccb093e274a892bbcf241cc63c26b1cbdc2" -->
<!-- galaxie:summary:start -->
- Run reviewed, bundled agent code. Same-origin code is trusted; client controls
  apply only on SDK-controlled paths and do not replace backend authorization.
- Keep agent calls on the model router and capability broker. Declare narrow,
  validated capabilities; never add generic fetch, SQL or shell access. No direct
  agent network, storage, DOM or eval. Treat tool output as data.
- Keep credentials out of agent code, prompts, state, checkpoints, traces and
  exports. Keep provider and tracing keys on the backend; use scoped short-lived
  write tokens and enforce spending limits at the host proxy.
- Preserve strict CSP and Trusted Types. Render registered components and text;
  never model-produced HTML/JS or password/payment components. Allowlist URLs.
- Significant writes require host-rendered, single-use confirmations bound to
  principal, capability, arguments, effect ID, policy revision and expiry.
  Backends still authorize every request and implement idempotency.
- Preserve destination consent, data labels, finite budgets and MCP metadata pins.
  Use host-controlled MCP servers. Attribution headers never authorize requests.
- Keep permission and grading logic deterministic; authoritative scores and
  transactions stay server-side. Put side effects after interrupts. Preserve
  cross-tab logout invalidation, principal wipe and in-flight result/approval
  invalidation. Keep the injection corpus in CI.
<!-- galaxie:summary:end -->

Describe controls and their documented limits. Never call galaxie or generated
apps `secure`, `secured`, `compliant` or `certified`, or suitable for regulated or
high-risk use. A Worker is not an isolation boundary for trusted author code.

## Change the existing wiring

- **Capability:** declare its name and input/output schemas in the agent definition,
  bind a narrow implementation in the host and grant it for the current principal.
  For significant writes, add host confirmation coverage and backend authorization
  and idempotency. Test denied, invalid and approved paths through the broker.
- **Model route:** declare the role and provider in host configuration, bind its
  model service and route the role through host policy. Review the final recipient,
  data labels and consent before changing destinations. Keep credentials in host
  transport callbacks; never construct an agent-held provider to bypass routing.
- **Tool:** use the selected adapter's capability helper over a declared, bound
  capability. Keep tool inventories static where the framework requires it, and
  preserve effect scopes and deterministic call order across resume/replay.
  See the framework reference present for helper names and refused shapes.

## Verify the app

Use the package manager and scripts in the app's `package.json`. In generated npm
projects run `npm run check` and `npm run build`; gateway apps also provide
`npm run build:server`. The generated check verifies types and the pinned CSP and
Trusted Types baseline. Keep its assertions; never loosen them to pass a build.
Exercise the changed flow with mock models and a loopback backend when applicable.
Generated checks do not establish real-model quality, device performance or that
an agent loaded this skill.

## Maintain these references in the galaxie repository

Citation comments bind restated rules to their source section bodies. After
reviewing a source change and updating this guidance, run
`node scripts/check-docs.ts --refresh-citations`, then `pnpm run check:docs`.
The refresh command belongs to the galaxie checkout, not the generated app.
