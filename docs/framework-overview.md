# galaxie — Framework Overview

> What galaxie is, where it is going, what it does for developers (including people coding with AI assistants), who it serves, and what it takes to become production-ready. The detailed contract is the [project brief](galaxie-project-brief.md); decisions and their reasoning are in the [ADRs](adr/README.md).

- **Date:** 2026-10-28
- **Status:** direction document. Nothing here is implemented yet.

## 1. Role: what galaxie is

Galaxie is a **browser-first agent runtime SDK**. It lets a web application host AI agents as first-class parts of the app. Each agent has an identity, state, a lifecycle, permissions, a UI region and a recovery story.

It sits between the tools developers already use and the application they already have:

| Layer | Who owns it | Examples |
| --- | --- | --- |
| Agent logic | The developer, with existing frameworks | LangGraph.js graphs, LangChain tools, plain TypeScript |
| **Agent host (galaxie)** | Galaxie | Lifecycle, identity, model routing, capability broker, persistence, UI surfaces, security baseline |
| Inference | Existing engines and providers | WebLLM, Transformers.js, Chrome Built-in AI, OpenAI-compatible endpoints |
| Application | The host app | Design system, login session, data, business rules |
| Services | Backends | HTTP APIs, MCP servers through a gateway |

What galaxie is not:

- a new LLM;
- a new graph engine;
- a compiler from Python or Node to WASM;
- a sandbox for untrusted code (yet);
- a marketplace.

### 1.1. The problem in the market

Adding an agent to an existing web app today means one of two incomplete paths:

- **Server-side agent stack.** Run the agent and the model behind an API, and wire a chat UI to it (CopilotKit, Cloudflare Agents, Hashbrown and Tambo with a backend proxy). Shared content can be cached, but per-user generation cannot:
  - feedback on a user's own writing;
  - summaries of a user's own data.

  Each such request costs tokens and sends the user's text to a server. Each app also builds its own orchestration, permissions and recovery.
- **In-browser inference engines.** WebLLM, Transformers.js and Chrome Built-in AI give you a model, not an agent host. Lifecycle, permissions, recovery after a reload, UI rendering, multi-tab behavior and security are left to each developer.

Five specific pains follow, and galaxie targets all five at once:

1. **Cost and privacy of server inference for per-user work.** Feedback on a learner's own writing, or summaries of a user's own documents, are generated per user and cannot be cached. Local inference removes the token bill and keeps the text on the device, where the device can do the job.
2. **No host for agents in the browser.** There is no standard way to give an in-page agent an identity, permissions, a UI region and a lifecycle.
3. **Fragile interactions.** A reload, a second tab or a double click breaks a waiting agent, or makes it repeat a side effect.
4. **No safety baseline for in-app agents.** Agents act with the user's session, so confused-deputy and prompt injection risks are real. Each team reinvents partial defenses.
5. **Agents are tied to one app.** Logic, credentials and backend calls are mixed, so an agent cannot move to another app without a rewrite.

Where galaxie fits:

- No project found combines all five; the individual pieces exist, and galaxie builds on them instead of replacing them.
- Galaxie fits where per-user inference cost, privacy, offline use or latency matter: education, health information, internal enterprise tools, and products with many free users. Server-side models remain the right default for many other features.

## 2. Direction

1. **Integrate, don't reinvent.** Run LangGraph.js, use existing inference engines and LangChain chat models, and adopt UI standards through adapters. Galaxie's value is the contract that ties them together.
2. **Local first, honest always.** Prefer in-browser inference. Choose where each model role runs, and always show the user where data goes. Never fall back silently.
3. **The host owns authority.** The app and its backend decide permissions, render the UI and hold the authoritative data. Agents request; hosts grant.
4. **Safe by construction.** The safe path is the easy path. Some unsafe things have no API at all: raw provider keys, generic `fetch` tools, rendering model HTML.
5. **Recover, don't restart.** A reload or crash restores the pending interaction from the checkpoint. It does not regenerate it.
6. **Reusable packages.** One agent package works in different apps through typed, versioned capability contracts.
7. **Evidence before expansion.** Every phase after the MVP has an entry gate based on measurements, not on enthusiasm.

## 3. What galaxie helps developers do

**In the MVP:**

| Job | Without galaxie | With galaxie |
| --- | --- | --- |
| Run a LangGraph agent in the browser | Fix bundling, write a browser checkpointer, handle interrupts and reloads yourself | Adapter plus IndexedDB checkpointer; interrupts survive reloads |
| Use a local model | Pick an engine, handle download consent, device checks, queueing, fallbacks | Per-role providers with first-run order, consent and typed `unavailable` errors |
| Let users bring their own model | Wire CORS, Local Network Access, keys and fallbacks per provider | OpenAI-compatible provider in host-proxy or user-endpoint mode; keys through a callback, never stored |
| Give the agent access to app data | Hand it `fetch` and hope | Typed, versioned capabilities bound to your existing APIs, deny by default |
| Connect MCP tools | Trust whatever the server lists | Allowlisted, namespaced, pinned tools from servers you control |
| Show interactive UI from the agent | Parse model output into JSX, or render HTML | Typed component registry with headless reference components; validated props and actions |
| Handle double clicks, stale tabs, two tabs | Custom locking and dedupe | Event identity and revision checks, Web Locks ownership, fencing epoch |
| Ship it safely | Read many security articles | A baseline enforced by the runtime, plus a checklist and tests for the host |
| Test it | Mock the LLM by hand | Deterministic mock provider, fixtures, injection corpus |

**Later, after the MVP gates (brief §16.7):** voice, third-party MCP with OAuth, OpenAPI import, a second renderer, LLM-composed UI, shared engines across tabs, untrusted package isolation, and a registry.

## 4. AI-assisted ("vibe") coding

Many integrators will build with an AI coding assistant. Those assistants copy whatever pattern is easiest, so galaxie's defaults must be safe even when nobody reads the docs.

What galaxie does for this audience:

- **No unsafe shortcuts in the API.** There is no parameter that accepts a raw provider key, no generic `fetch` capability, no way to render model HTML, and no runtime agent loading. An assistant cannot generate code that uses an API that does not exist.
- **Types that explain the contract.** Capability bindings fail to compile when the schema does not match. Errors are typed and carry a short fix hint that an assistant can act on, for example "role `tutor.feedback` allows only `in-browser`; add a provider or change the role policy".
- **Dev-mode diagnostics (M4).** In development, the runtime warns about the following. This is best effort, because page code cannot see every effective CSP or every stored key.
  - a missing CSP directive or Trusted Types;
  - unbound capabilities;
  - provider keys found in storage;
  - model-produced URLs blocked by the allowlist;
  - roles without an available provider.
- **AI-facing docs (M4).** Each package ships `AGENTS.md` and the docs site ships `llms.txt`: short, current rules, plus "do this, never that" examples that coding assistants can load. They also state the license plainly: a closed-source product needs a commercial license [ADR-0015].
- **Lint rules for agent code (M4).** The ESLint plugin flags direct `fetch`, storage, DOM and `eval` calls, and side effects before `interrupt()`.
- **Templates (examples in M4, a scaffolder later).** Working host apps with the CSP, a host-proxy endpoint and an MCP server already set up, so the first copy-paste is correct.
- **Mock provider and fixtures.** Assistants can write tests that run without a GPU.

What galaxie cannot do for this audience: replace server-side authorization, review the app's own code, or make an XSS bug harmless. The docs say so plainly.

## 5. Audiences

Galaxie serves three groups. End users never install galaxie; they meet it inside a host app.

### 5.1. End users (general public)

| Need | How galaxie addresses it |
| --- | --- |
| Know where my data goes | Destination labels per role ("runs in your browser", "sent to this app's server"); data labels keep a user's own text on SDK paths inside the browser by default |
| Not be surprised by large downloads | Size shown and consent before a model download; metered connections respected where the browser exposes it |
| Use the feature on modest devices | Built-in AI first, in-browser engine if possible, remote only with consent, otherwise a clear "not available" state |
| Accessibility | Reference components target WCAG 2.2 AA: keyboard use, focus, labels, error states |
| Language | UI text through the host's i18n; model roles declare languages they were evaluated for |
| Safety, including minors | Output safety hook; no password or payment components; agent content visibly marked |
| Control over personal data | Local data partitioned per user, wiped on logout; export only on explicit action |

### 5.2. Developers

| Need | How galaxie addresses it |
| --- | --- |
| Fast start | Templates, headless reference components, mock provider |
| Keep existing skills | LangGraph.js and LangChain as-is; no new DSL |
| Confidence in upgrades | Semantic versioning, deprecation policy, migration guides, compatibility matrix |
| Debuggability | Local trace with redaction, typed errors with fix hints, dev-mode diagnostics |
| Testability | Deterministic mocks, fixtures, conformance suites for adapters |

### 5.3. Enterprises

| Need | How galaxie addresses it (direction, not yet built) |
| --- | --- |
| Security review | Public threat model, security baseline, SBOM, signed releases with provenance, third-party audit summary before 1.0 |
| Data residency and control | Per-role destination policy; `in-browser` and `host-server` only; self-hosted model assets; no telemetry by default |
| Central policy | Org-level policy presets set by the host that agent packages cannot widen |
| Audit | Content-free audit events (who, which agent, which capability, which destination, when) exportable to the host's logging or SIEM |
| Incident response | Host-controlled kill switch per agent, role, provider or MCP server; staged rollout of model updates |
| Stability | LTS releases with security backports; documented support windows |
| Legal clarity | AGPL-3.0 for open use, or a commercial license for closed products [ADR-0015]; model and dependency license metadata |
| Offline or air-gapped use | Self-hosted weights and runtimes; in-browser providers only |
| Accessibility procurement | An accessibility conformance report for the reference components |

## 6. Roadmap at a glance

Full detail, with entry gates and evidence requirements, is in [brief §16](galaxie-project-brief.md#16-roadmap).

| Stage | Focus | Leaves when |
| --- | --- | --- |
| M0 — Spikes | A: engine and persistence; B: local inference bake-off; C: UI path; D: remote providers and MCP | Observed compatibility matrix; in-browser engine chosen; Proposed ADRs confirmed or revised |
| M1 — Headless host | Lifecycle, identity, broker, model router, budgets, redacted trace | Headless agent tested; core security guarantees covered |
| M2 — Local slice | Tutor steps 1–10 with local models, typed registry, consent, CSP | Learner's sentence never leaves the browser; loop runs without a server |
| M3 — Durability | IndexedDB saver, submission inbox, interrupt recovery, effect journal, multi-tab, external developer trial | Reload never changes the quiz, loses an answer or duplicates effects; an outside developer has integrated the slice |
| M4 — Release gate | Remote providers, MCP, two hosts, second external developer trial, security review, AI-facing docs | All required acceptance tests have evidence; Go/Revise decided on numbers |
| Phase 5 | Integration breadth: third-party MCP with OAuth, OpenAPI, Transformers.js non-LLM tasks, voice | Each item's entry gate |
| Phase 6 | Portability and scale: worker executor, multi-model pool, second renderer, LLM-composed UI | Each item's entry gate |
| Phase 7 | Isolation and distribution: untrusted packages, registry, WebMCP bridge | Isolation ADR and test suite first |
| 1.0 | Production readiness (§7 below) | Every 1.0 criterion met |

## 7. Path to production readiness (1.0)

"Many users" means three things for galaxie: many devices (each client runs its own runtime), many host apps (many integrators) and the server parts that hosts run (host proxy, MCP gateway, model asset CDN). 1.0 needs all of the following.

**Stability**

- Public API reviewed and frozen under semantic versioning; deprecation policy; LTS line with security backports.
- Checkpoint and manifest schema migrations, with tests for every supported upgrade path.

**Security**

- The security baseline (ADR-0012) fully covered by tests.
- An external security review or penetration test of the runtime and the reference gateway, with a public summary.
- `SECURITY.md` with a coordinated disclosure process and response targets.
- Signed releases with npm provenance, an SBOM per release, minimal dependencies, and a dependency update policy.

**Reliability**

- Conformance suites for executor adapters, the checkpoint saver and renderers.
- Fault injection in CI.
- Real-GPU browser matrix runs on self-hosted runners.
- Host-controlled kill switches and staged rollout for models and agents.

**Server side at scale (host-run)**

- A reference gateway and host proxy with rate limits, per-user quotas and cost budgets, and a deployment guide.
- A model asset CDN guide with hashes and caching.

**Operability**

- Content-free observability hooks (OpenTelemetry-compatible spans and metrics), off by default and owned by the host.
- Upgrade guides.

**User experience**

- WCAG 2.2 AA reference components.
- Tested i18n paths.
- Measured performance on low-end reference devices.

**Docs and DX**

- Guides, API reference, examples and templates.
- AI-facing docs (`AGENTS.md`, `llms.txt`).
- Troubleshooting for CSP, Local Network Access, CORS and GPU issues.

**Governance**

- License (AGPL-3.0-only plus a commercial license) reviewed by a lawyer [ADR-0015].
- Contribution guide with a CLA, which dual licensing needs (a DCO is not enough), a code of conduct and a trademark policy.
- Release process, named maintainers, and a public roadmap.

**Compliance support**

- Data-flow documentation per destination class.
- Guidance for hosts serving minors.
- An accessibility conformance report.

Galaxie is an SDK, so it cannot be certified on behalf of its users, and it never claims compliance. It supports the host's own compliance work by documenting its controls and their limits.

## 8. What to make public and what to keep private

Under the license (AGPL-3.0-only plus a commercial license [ADR-0015], see [`COMMERCIAL-LICENSE.md`](../COMMERCIAL-LICENSE.md)):

- The code is public and open source.
- Forks must stay open when they are distributed or offered over a network.
- Closed-source use needs a commercial license.
- The security baseline is the same under both licenses. It is never a paid feature.

**Public**

| Item | Why public |
| --- | --- |
| Runtime SDK packages, adapters, ESLint plugin | Adoption depends on developers reading and trusting the code |
| Contracts, schemas, catalog specs | Reuse across hosts needs open contracts |
| Conformance test suites | Lets others build adapters and renderers that interoperate |
| Docs, ADRs, roadmap, changelog | Explains decisions; builds trust |
| Threat model and security baseline | Security must not depend on secrecy; enterprises need it for review |
| Benchmarks: method, devices and raw results | Claims must be checkable |
| Compatibility matrix and known limitations | Prevents false expectations |
| Most of the prompt injection corpus | Helps the ecosystem; attackers already know the techniques |
| Data-flow description per destination class | Users and hosts must know where data goes |
| Model descriptors with license and provenance | Legal and supply chain review |

**Private**

| Item | Why private |
| --- | --- |
| Signing keys, npm tokens, CI and provider credentials | Compromise means a supply chain attack on every user |
| Details of unpatched vulnerabilities | Coordinated disclosure; publish after the fix |
| A holdout part of the injection corpus and eval sets | Prevents tuning to the test; keeps measurements honest |
| Any user or learner data | Galaxie does not collect it by default; hosts own it |
| Customer configurations, enterprise contracts, raw incident data | Confidential; publish sanitized post-incident summaries instead |

## 9. Language and tooling

Galaxie is TypeScript, built with TypeScript 7 (the native Go compiler). TypeScript 7.0 ships no compiler API, so tools that need one keep running on TypeScript 6.0 side by side until they support the 7.1 API [ADR-0013].

Rust is not chosen for the MVP:

- The code runs in the browser in the host's origin, where Rust compiled to WASM does not add isolation.
- The main threats are authority and logic flaws, not memory corruption.

Rust remains a candidate for a WASM isolation guest (Phase 7), for measured hot paths, and for a high-load gateway.

[ADR-0013]: adr/0013-typescript-first-implementation.md
[ADR-0015]: adr/0015-licensing-agpl-with-commercial-license.md
