# Local trace sinks

This isolated demonstration sends real galaxie LangGraph runs from a Node host
or a built Chromium page to a local collector, then reads every emitted span back
from Langfuse and MLflow.
It also retains the original hand-made two-span smoke. Vendor mapping belongs to
the collector; no galaxie package is changed.

## Requirements and run

Use Node 24 or later, pnpm 11, Docker Compose and a running Docker daemon with
about 10 GB of memory. The live port check uses the host's `lsof` command. Ports
3000, 4318 and 5100 must be free. From the repository root:

```sh
pnpm install
pnpm build
cd spikes/llmops-trace-sinks
pnpm install --frozen-lockfile
pnpm exec vitest run test/single-copy.test.ts test/static.test.ts test/lifecycle.test.ts
pnpm exec tsc --noEmit
pnpm run stack:up
pnpm run smoke
pnpm run node-host
pnpm run browser-host
# Run again and compare the results files (see below).
pnpm run node-host
pnpm exec vitest run test/static.test.ts
pnpm run stack:down
```

Always run `stack:down` after a run, including a failed smoke test. It removes
the stack's containers, network and named volumes, and clears only the experiment
ID from `.env`. It destroys this stack's stored traces. It retains the image cache
and generated credentials. Remove the ignored `.env` after teardown if you want
fresh credentials on the next start.

The maintainer machine uses colima; this is not a requirement:

```sh
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
# Only if colima is stopped:
colima start --cpu 4 --memory 10 --disk 60
```

The Docker daemon must be able to bind-mount this checkout's `collector.yaml`.
Colima's default shared paths include `/Users`; a clone under `/private/tmp` is
not shared on the measured setup. Use a clone under `/Users` with that setup.
The bind mount refuses to create a missing daemon-side path.

`stack:up` generates `.env` with mode 0600 only when absent. Do not copy
[.env.example](.env.example) over it: that file lists names with empty values.
Passwords, the headless user email, project keys and collector Basic auth value
are generated locally. Inspect `.env` locally to log in; never paste it into a
report. Signup is disabled; headless initialization creates the initial user.
Startup checks the host ports, waits for backend health, looks up or creates
the `galaxie-smoke` MLflow experiment, updates that one `.env` key, then recreates
the collector. Run `stack:down` before another `stack:up`.

The helper pins the compose file and project, ignores inherited `COMPOSE_*`
settings, and makes the local environment file authoritative over conflicting
shell variables. Teardown also works when `.env` is missing, using the empty
template without generating credentials.

## Services and controls

| Host address | Service |
| --- | --- |
| `http://127.0.0.1:3000` | Langfuse web |
| `http://127.0.0.1:5100` | MLflow with SQLite in a named volume |
| `http://127.0.0.1:4318/v1/traces` | Collector OTLP/HTTP receiver |

Only these ports are published. Postgres, ClickHouse, Redis, MinIO and the
Langfuse worker remain on the compose network. The collector listens on all
interfaces inside its container; Docker publishes it only on `127.0.0.1`.
The smoke test checks both Docker publication and host listeners. A wildcard
host listener fails the test, including one created by a VM port forwarder.
There is no Docker socket mount, host networking or privileged container.
Langfuse and MLflow vendor usage telemetry is not disabled here (see the last paragraph of
this section); container egress is not blocked by this stack.
Loopback publication does not authenticate other local processes or provide
an isolation boundary against trusted code on this machine.

The [compose file](compose.yaml) follows the upstream
[Langfuse v4.80.0 compose](https://github.com/langfuse/langfuse/blob/v4.80.0/docker-compose.yml).
The adapted wiring's MIT notice is in [LICENSE-UPSTREAM](LICENSE-UPSTREAM).
This stack omits the AI gateway and unused S3 batch-export configuration, removes
upstream database, object-store and worker publications, generates all credentials,
and adds backend health checks. Langfuse's Node servers bind their container
hostname, so their internal health checks use that hostname.

MLflow's middleware remains enabled. Its explicit allowed hosts are `mlflow:5100`
and loopback/localhost with the published port; CORS allows only the two local
MLflow origins. This narrows MLflow's defaults while allowing the collector's
service-name request. The ignored `MLFLOW_PORT` can change the host port; the
container port stays 5100. The helper rejects collector endpoints outside this
compose network. The collector endpoint variables use its `${env:NAME}` syntax.

The inspected core collector lacks `transform`, so this demonstration uses the
digest-pinned contrib distribution. Its pinned version accepts the `otlphttp`
exporter alias, with a deprecation warning. The collector conditionally copies
`galaxie.session.id` into `session.id`, promotes `galaxie.run.id` into
`langfuse.observation.metadata.galaxie.run.id`, and fans out to both sinks.
Langfuse receives Basic auth and ingestion-version header 4. MLflow receives the
experiment header with `compression: none`; no gzip experiment was run.

Langfuse and MLflow vendor usage telemetry stays at its defaults by maintainer
decision for this developer debugging stack. The collector routes galaxie trace
data only to the local backends. The Node host uses only synthetic prompts and replies, exported only with the
development text opt-in. The credential canary reaches the local scripted
provider and is asserted absent from both backend readbacks. Galaxie trace data,
opted-in text and the canary go only to the local backends; no real provider is
called. Vendor telemetry payloads and all container egress were not measured.

## Workspace and verification

This workspace stays outside root CI. Its lock was seeded from
`../langgraph-nodeinterrupt-pause-time/pnpm-lock.yaml`, then regenerated once
after adding dependencies; frozen installation passes. It uses `link:` dependencies
on built galaxie packages, including the private ADK, Pyodide and Go adapters.
The full root build is required because the guard checks every public built export,
including the models package's subpaths.

A Vite resolver and `resolve.dedupe` pin OpenTelemetry API, LangChain core and
LangGraph to the spike's copies. The runner test resolves each applicable module
from each linked built export and compares paths with the runner's path. Only
packages that do not declare a dependency or peer on a module skip that module.
The counterexample disables the resolver and exposes the second OpenTelemetry API
path reached from linked core. Plain Node resolution outside this runner is not
covered.

`pnpm test` runs offline guards and explicitly skips the live suite. `pnpm run
smoke` and `pnpm run node-host` enable their live suites with `LLMOPS_STACK=1`;
an unreachable stack then fails. The
offline guards parse both YAML files, reject unsafe publication and literal
credentials, check digest pins, and scan tracked/unignored spike files and
results for generated credentials. Public routing settings and the short MLflow
experiment ID are excluded from that credential scan.

## Measured result and limits

[versions.json](results/versions.json) records the actual machine, runtime
versions, pulled image digests and collector decision.
[smoke.json](results/smoke.json) records normalized API readback and host publication.
Generated trace, span, session and run IDs and timestamps are relabeled; timing
fields are observations, not performance measurements.

The smoke test reads Langfuse's v2 observations API and MLflow's v3 trace search
and detail APIs. It checks the posted trace and span IDs, two observations and
one trace with two spans, parent links and typed attributes. It checks session
mapping on the root and its absence on the child, plus the promoted run metadata.
MLflow's search grammar calls the trace identifier `trace.request_id` even when
the response field is `trace_id`. Counts are checked again after two seconds.
These counts demonstrate one sampled delivery; they establish no delivery
guarantee under retries or failures.

The original smoke measures no galaxie run. The Node host measurements below
add one LangGraph shape per scenario, with and without text; they do not establish
executor coverage. This is a local development demonstration, not a deployment
recommendation.


## Span coverage per executor family

[coverage-matrix.json](results/coverage-matrix.json) records a separate coverage
lane. Run it after the root build and spike install above, while the stack is up:

```sh
# Use the Go 1.27.3 toolchain directory on this machine.
export GO_TOOLCHAIN_BIN="$(go env GOROOT)/bin"
export PATH="$GO_TOOLCHAIN_BIN:$PATH"
pnpm run span-coverage
shasum -a 256 results/* > /tmp/galaxie-coverage-before.sha256
pnpm run span-coverage
shasum -a 256 results/* > /tmp/galaxie-coverage-after.sha256
diff -u /tmp/galaxie-coverage-before.sha256 /tmp/galaxie-coverage-after.sha256
pnpm run stack:down
```

The maintainer toolchain is under
`$HOME/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.27.3.darwin-arm64/bin`;
put that directory on PATH before the root build or validation if the default Go
version differs. Python needs the already populated `.cache/python-wheels/`
cache, its `local-wheels.json`, all locked wheels and the installed Pyodide runtime.
Neither family downloads assets. Missing prerequisites produce an `unmeasured`
row with the exact reason and repo-relative probes. Runtime assertion failures
fail the lane and leave the previous matrix intact.

| Family | Scripted model / capability calls | Emitted root / node / model / capability spans | Measurement |
| --- | --- | --- | --- |
| LangGraph JavaScript | 1 / 1 | 1 / 2 / 1 / 1 | Both local backends |
| ADK JavaScript | 2 / 1 | 1 / 1 / 2 / 1 | Both local backends |
| LangGraph Python in Pyodide | 1 / 1 | 1 / 0 / 0 / 1 | In memory, by maintainer decision |
| ADK Go | 2 / 1 | 1 / 0 / 0 / 1 | In memory, by maintainer decision |

Each scenario calls one capability after a model. ADK's tool-calling loops call
the model again after the tool result. Fixture provenance and scripted counts are
in each row. The Python model counter, Go's independent golden wire transcript,
capability counters, exact successful outputs and captured root/capability spans
are positive controls for the missing-span findings. Separate providers also
check that these in-memory trees contain no ADK JavaScript spans.

Both live families match the in-memory oracle by span ID and parent link in each
backend. Langfuse types root/node/model/capability as
`AGENT`/`SPAN`/`GENERATION`/`TOOL`; MLflow uses
`AGENT`/no type/`CHAT_MODEL`/`TOOL`. Langfuse shortens capability names to
`lookup@1` or `math.double@1`; MLflow retains the emitted names. LangGraph's model
usage is 2 input / 3 output / 5 total tokens; each ADK model call records 2 / 2 / 4.
Both backends retain those values. Python and Go have no model spans, so usage is
explicitly not applicable, and their backend columns say
`not measured: maintainer decision`.

ADK's own spans have a separate row. With no context manager in the measured
run, five spans form five separate traces, share no galaxie trace, and have empty
attributes. They therefore classify as `other` in the coverage model; Langfuse
stores all five as `SPAN`, while MLflow assigns no type. Their names include
`call_llm` and `execute_tool math_double_1`, but names alone do not establish
model or capability attributes or usage.

The measured run sets `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS=false`. An earlier
in-memory control enables capture and a Node AsyncLocalStorage context manager
because ADK writes attributes onto the active span after awaits. It detects all
four prompt, reply, argument and result markers. The forwarding exporter gate
stays closed during that control and is flushed before opening. The measured
run removes the context manager, and scans emitted attributes and complete raw
backend responses for every marker and the credential canary. This proves the
scanner can see content; it does not isolate the flag's effect from the missing
context manager. No control content is exported.

The spike's devDependency links `@google/adk` to the adapter's already pinned
2.3.0 copy; an offline real-path check verifies it is the same package. The link
is in devDependencies because ADK's wildcard exports are incompatible with the
existing built-export guard. No galaxie dependency or adapter changes.

Two gaps are derived from the measured rows:
`pyodide-langgraph-python-span-coverage` and `adk-go-span-coverage`.
Each proposes node and model instrumentation, including response usage, through
the existing framework-neutral `RunTrace` contract at the adapter bridge. Vendor
mapping stays in the host collector. Their issue IDs are `PENDING-CLAUDE` for the
delegating session to replace; no tracker operation runs in this lane.

The default `pnpm exec vitest run` remains offline, including schema mutations,
marker detection, missing-cache and toolchain-mismatch controls. Only
`LLMOPS_STACK=1` enables the new live file (`pnpm run span-coverage`).
`LLMOPS_REQUIRE_GAP_IDS=1 pnpm exec vitest run test/coverage-static.test.ts`
deliberately fails until the placeholders are replaced. The matrix writer
audits all rows, derives the exact gap set, formats with Biome and renames one
complete file atomically. Results contain no generated IDs, timestamps or local
paths.

Not measured: ADK Python, DSPy and Pydantic AI drivers; browsers, engines or real
devices; real models or answer quality; ADK nesting with a context manager;
Langfuse/MLflow classification of Python or Go spans; delivery guarantees,
retries, capacity or latency; vendor telemetry payloads or all container egress.
Langfuse and MLflow vendor telemetry stays at its defaults by maintainer decision.
Galaxie trace data, opted-in text and the credential canary go only to the local
backends under the existing stack controls; this lane exports no opted-in text.

## Node host measurements

`pnpm run node-host` runs four scripted graphs twice each, with tracing text
omitted and then with `developmentTraceText: { destination: 'host-server' }`.
Inputs and capability outputs are labelled `public`; the boolean interrupt
submission introduces no private text. Each scenario has its own app and session
identity. The provider declares `credential: true`, consent is explicit, and
`getCredential` must have run before any backend read or credential scan. The
scripted factory verifies that it received the canary. It makes no model request.

The host supplies a `TracerProvider`, a `BatchSpanProcessor` and the OTLP/HTTP
exporter, fixed to `http://127.0.0.1:4318/v1/traces`. An in-memory exporter records
the oracle beside it. Disposal, force-flush and shutdown finish each scenario.
The pinned exporter is **0.301.0**, aligned with **sdk-trace 3.1.0**. Backend
versions rechecked in this run are **Langfuse 4.80.0**, **MLflow 3.18.0** and
**otelcol-contrib 0.154.0**. The collector mapping is unchanged.

| Scenario (spans per variant) | Langfuse | MLflow |
| --- | --- | --- |
| Linear (3) | `AGENT` root, node, `GENERATION`; fixture-1; 2 input / 3 output tokens | `AGENT` root, node, `CHAT_MODEL`; same model and usage |
| Tool call (5) | `TOOL` named `lookup@1`, under the lookup node | `TOOL` named `execute_tool lookup@1`, under the same node |
| Interrupt/resume (8 across 2 traces) | Shared promoted run ID; segments 0 and 1; server metadata filter finds both | Shared run ID and segments on two roots |
| Model failure (3) | Model, node and root have `ERROR` level and `error.type`; root alone carries `galaxie.error.code` | Matching `STATUS_CODE_ERROR` and typed failure attributes |

Every oracle span ID and parent link was found in both backends: 38 spans across
10 traces per full live run. Complete observations, trace-search responses and
trace-detail bodies are scanned before projection. The canary and the synthetic
error message are absent in both modes. Default traces contain none of the
synthetic prompt, reply, input, capability argument or result markers.

With text enabled, model prompts and successful replies appear as generation
input/output in Langfuse and span inputs/outputs in MLflow. Failed generations
have input only. **Neither backend's root carries input or output**, in either
mode. Capability results are absent. Langfuse's run query uses its v2 observations
API with a `stringObject` metadata filter on `galaxie.run.id`; this is a server
filter, not a client-side listing fallback.

Recorded findings (all retained as `observed` measurements in
[node-tool-call.json](results/node-tool-call.json)):

1. Langfuse changes the emitted `execute_tool lookup@1` name to `lookup@1`.
2. Langfuse removes opted-in `gen_ai.tool.call.arguments` from the attributes and
   places the JSON string in the tool observation's input. The value survives.
3. MLflow parses that JSON string into an object in both the attribute and tool
   span input. Its value survives, but its attribute type changes.

The credential-routed failure path deliberately generalizes the scripted
`FixtureModelError` type to `Error`; the offline oracle verifies this existing
adapter control. The root still carries `executor_error`. No backend mapping
change or galaxie change was made to adjust these measurements.

[node-linear.json](results/node-linear.json),
[node-interrupt-resume.json](results/node-interrupt-resume.json), and
[node-model-failure.json](results/node-model-failure.json) contain the other
projections. IDs are relabelled in parent-first oracle order. Timestamps become
`<timestamp>`; timing, project fields, service resource paths and unrelated API
fields are omitted. Typed attributes, token counts, status, model names, I/O and
parenting are retained. Raw API bodies and credentials are never written to
results. The live writer uses the root's installed Biome formatter so reruns
preserve the committed JSON format as well as values.

To repeat the stability check while the stack is up:

```sh
pnpm run node-host
shasum -a 256 results/* > /tmp/galaxie-node-host-before.sha256
pnpm run node-host
shasum -a 256 results/* > /tmp/galaxie-node-host-after.sha256
diff -u /tmp/galaxie-node-host-before.sha256 /tmp/galaxie-node-host-after.sha256
```

[node-verification.json](results/node-verification.json) records the commands,
checks, stable hashes, publication check and teardown from this run. The default
`pnpm test` remains offline and skips both live suites. The live command fails
when the stack is down. Root checks require the project's Go 1.27.3 on PATH.

The Node lane does not measure browser export; the page measurements follow below.
Not measured in the Node lane: other executors; budget exhaustion or cancellation;
real models, real prompts or answer quality; feedback scores or MLflow evaluation;
session grouping workflows; retries, delivery guarantees, capacity, latency,
long-running ingestion or failure recovery; vendor usage telemetry payloads or
all container egress. These are single sampled deliveries with a scripted model.


## Chromium page measurements

`pnpm run browser-host` builds a minified Vite page and drives it with the spike's
pinned `playwright-core` 1.64.1 in headless Chromium 156.0.8078.4 (shell revision
1248). The browser is installed separately from dependencies. If the matching
cached shell is absent, install it once in this spike:

```sh
pnpm exec playwright-core install --only-shell chromium
```

The page runs the same scripted linear and interrupt/resume scenarios as Node,
without and with development trace text. The host uses OTLP/HTTP exporter
0.301.0, SDK 3.1.0, resources 3.1.0 and API 1.10.0; Vite is 8.3.4. Linked galaxie
packages, API, LangChain and LangGraph resolve through the same single-copy helper
as the Node runner. The production build independently counts one resolved copy
of each shared package. No vendor SDK or backend dependency enters a galaxie
package.

Vite preview binds only loopback on a free port. Its single proxy route rewrites
`/otel/v1/traces` to the collector's `/v1/traces` receiver path. Preview serves the
built bundle; it uses the dev proxy's forwarding semantics without a development
bundle. The collector configuration is unchanged and needs no CORS addition.
The response policy is:

```text
default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'
```

| Scenario, per text variant | Oracle | Langfuse | MLflow |
| --- | --- | --- | --- |
| Linear | 3 spans, 1 trace | All IDs and parents; `AGENT`, node, `GENERATION` | All IDs and parents; `AGENT`, node, `CHAT_MODEL` |
| Interrupt/resume | 8 spans, 2 traces | Both segments returned by the server run-ID metadata filter | Both roots and all children retained |

[browser-linear.json](results/browser-linear.json) and
[browser-interrupt-resume.json](results/browser-interrupt-resume.json) exactly
match their Node counterparts, with **no lane-specific attribute exceptions**.
The shared readback checks compare every backend span with the page's in-memory
oracle, pin counts independently, inspect complete API responses before
projection, and require positive credential calls and opted-in text. The JSON
snapshot round trip retains context, parenting, status, events, links, scope,
ended state and timing; the existing span-tree guard checks the decoded spans.
Neither backend adds root input/output. No browser backend representation finding
was observed for these two scenarios.

[browser-evidence.json](results/browser-evidence.json) records the bundle scan,
all page request summaries and the CSP control. A passive preview receiver
capture also scans every incoming request: the measured navigation keepalive
export reaches that receiver after Playwright stops reporting the page request.
Both captures persist only summaries. The scanner sees full URLs,
complete headers and body bytes in memory, but persists only paths, methods,
header names and counts. It detects nonempty generated credentials in raw,
URL-encoded and base64 forms, Basic values and patterns, vendor header names,
and the routed canary. A short numeric experiment identifier is checked in URL
segments, query values and header values, excluding Chromium's standardized
`upgrade-insecure-requests` protocol bit. That bit still receives all credential
and canary checks. Bodies and bundle numbers are not interpreted as experiment
identifiers. Synthetic positive controls exercise both scanners. No generated
credential appeared in the bundle or either request capture. No page request or
complete backend response contained the routed canary. Generated credentials in
complete backend responses were not scanned; the separate static guard checks
all saved results against generated `.env` values.

The direct-export control uses only the collector origin and records four
`connect-src` violations, zero collector requests observed by Playwright and
zero spans in either backend throughout a 15-second observation window after a
later proxied run was successfully read back. The exporter reports one flush
error, which the dedicated control deliberately counts. Proxied runs have no
`connect-src` violation. No eval or other CSP violation was observed. URLs in the
recorded control are replaced with destination labels; ports and local paths are
not persisted.

[browser-close.json](results/browser-close.json) records observations, without a
delivery assertion. Each case has a 60-second batch delay and a 15-second backend
observation window:

| Mechanism | Auto flush on document hide | Langfuse / MLflow spans |
| --- | --- | --- |
| Close immediately, no explicit flush | Disabled | 0 / 0 of 3 |
| Navigate away, no explicit flush | SDK default | 3 / 3 of 3 |
| Explicit force-flush and shutdown, then close | SDK default | 3 / 3 of 3 |

The lifecycle field lists only callbacks successfully relayed to Playwright;
callbacks during document destruction are not a complete browser event log.
The counts demonstrate sampled delivery, not a delivery guarantee. No `pagehide`
or `sendBeacon` mitigation was added.

### Guide probe and differences

[browser-guide.json](results/browser-guide.json) records two scratch installs
outside the repository. The browser-exporter guide excerpt was tried verbatim,
then a separate harness created one SDK span and flushed it to a same-origin
loopback stub. Both package sets passed typechecking, Vite build and Chromium
export:

| Tags | Web/base SDK | OTLP/HTTP exporter | API |
| --- | --- | --- | --- |
| `latest` | 2.12.0 | 0.301.2 | 1.10.0 |
| `latest-2` | 2.12.1 | 0.223.2 | 1.10.0 |

Both sets emitted unmet API peer warnings; pnpm retained one API version rather
than installing a second one, and each scratch bundle contained one API copy.
The `latest` web/base SDK tags were deprecated. The guide's constructor and
`register()` worked in both sets. These are initialization and one-span stub
measurements, not galaxie graph or backend parity with the web SDK packages.
The guide stays unchanged.

The live page instead keeps the Node lane's aligned SDK/exporter pair. Its code
shape differs from the guide as follows:

- Import `TracerProvider`, `BatchSpanProcessor` and `StackContextManager` from
  `@opentelemetry/sdk-trace`, rather than the web/base SDK packages.
- Construct the processor with `new BatchSpanProcessor({ exporter })`. The pinned
  provider has no `register()` method. Register it with
  `trace.setGlobalTracerProvider(provider)` and install
  `context.setGlobalContextManager(new StackContextManager().enable())`; pass the
  same provider to the runtime. Parenting still uses explicit contexts and the
  forwarded graph config, not async browser context propagation.
- Keep an in-memory oracle beside the batch processor. After runtime disposal,
  call `provider.forceFlush()` and `provider.shutdown()` for normal runs. The
  close observations deliberately defer those calls; the direct CSP control
  counts their errors. Only close observations set the 60-second delay or disable
  auto flush on hide.
- Use the preview proxy for the built bundle, with an explicit receiver-path
  rewrite. The exporter uses the browser `fetch` transport with conditional
  `keepalive`, not XHR or `sendBeacon`.

The first live scan exposed a measurement-harness false positive: a short
experiment identifier equalled Chromium's standard navigation preference bit.
A failing offline regression reproduced it before the scanner distinguished
that protocol flag; arbitrary identifier headers and credentials in that header
still fail. The original failure is retained in
[browser-verification.json](results/browser-verification.json).

Langfuse and MLflow vendor telemetry stays at its defaults by maintainer
decision. Galaxie trace data and opted-in text reach only the local backends;
the credential canary reaches only the local scripted provider and is absent
from page requests and backend readbacks.

### Repeat and limits

With the stack running, repeat the browser command and compare every results file:

```sh
pnpm run browser-host
shasum -a 256 results/* > /tmp/galaxie-browser-before.sha256
pnpm run browser-host
shasum -a 256 results/* > /tmp/galaxie-browser-after.sha256
diff -u /tmp/galaxie-browser-before.sha256 /tmp/galaxie-browser-after.sha256
pnpm run node-host
pnpm exec vitest run test/static.test.ts
pnpm run stack:down
```

[browser-verification.json](results/browser-verification.json) records the live
runs, stable hashes, loopback publication, stopped-stack failure, teardown and
repository gates. The default offline suite skips all live tests and never
launches a browser. The enabled browser command fails when the collector is
unreachable. Teardown removes volumes as well as containers.

Not measured in that Chromium ingestion lane: browser tool-call or model-failure scenarios, other executors,
Firefox, WebKit, real devices, real models or prompts, answer quality, feedback
scores, session grouping, delivery guarantees, retries, capacity, latency,
long-running ingestion, failure recovery, vendor telemetry payloads or container
egress. Proxy authentication, request limits and origin policy beyond this local
CSP/loopback fixture are not deployment measurements.

## Host feedback, sessions and deterministic evaluation

The feedback measurements extend the same local stack with host-only code. No
galaxie package or collector mapping changes. Run them from this spike:

```sh
pnpm install --frozen-lockfile
pnpm run python:lock-check
pnpm run python:sync
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
pnpm run stack:up
pnpm run feedback-node
pnpm run feedback-browser
shasum -a 256 results/* > /tmp/galaxie-feedback-before.sha256
pnpm run feedback-node
pnpm run feedback-browser
shasum -a 256 results/* > /tmp/galaxie-feedback-after.sha256
diff -u /tmp/galaxie-feedback-before.sha256 /tmp/galaxie-feedback-after.sha256
pnpm run stack:down
```

Always run `stack:down`, including after a failed measurement; it removes volumes.
The default offline tests need neither the stack, Chromium nor the Python
environment. `LLMOPS_STACK=1` enables only the explicitly invoked live files.

| Workflow | Measured outcome |
| --- | --- |
| Segment scores | Each interrupt/resume segment receives one score on its own oracle trace. Unknown runs and segments return `unmapped` and send no POST. |
| Score retries | Stored payload retries (the client keeps the first payload and resends it unchanged) retain one score with its original value and timestamp. Resending the same ID with a payload dated on a later day left one visible row holding the new value; the original value was no longer returned. Whether a second physical row exists behind the read API is unmeasured. |
| Score before ingestion | Zero observations before explicit flush, then all three observations; the single score is unchanged and names the oracle trace. |
| Langfuse sessions | Root-only copy finds three roots per session but misses six child observations. The host processor groups all nine observations per session. |
| MLflow sessions | Root-only copy suffices for `mlflow.trace.session`; two sessions each return exactly their three traces in every phase. |
| MLflow evaluation | Six traces per text mode, six rows and six values per scorer. Usage is five per trace; chat text presence follows opt-in. Root request/response are absent in both modes. |
| Browser feedback | Own reports return 200; wrong trace or segment 404; a confirmed association already owned by another user 403; missing cookie 401. Bundle, full requests, receiver wire requests and response bodies pass the credential scans and their positive controls. |

[feedback-scores.json](results/feedback-scores.json),
[sessions.json](results/sessions.json),
[mlflow-evaluation.json](results/mlflow-evaluation.json) and
[browser-feedback.json](results/browser-feedback.json) hold the normalized facts.
[gaps.json](results/gaps.json) dispositions all seven workflows with resolvable
evidence pointers. The root-I/O follow-up is filed as `galaxie-d53.7`; the
delegating maintainer session replaced the placeholder before merge.
`LLMOPS_REQUIRE_GAP_IDS=1 pnpm exec vitest run test/static.test.ts` enforces that
handoff without contacting a tracker.

`RunTraceMap` observes root `invoke_agent` spans at `onStart`, recording run ID,
segment, session and trace ID. It changes no span. `SessionCopy` is optional:
collector-only measurements run first, followed by the processor with text off
and on. Sequential starts reuse each of two agent instances for three runs.
Neither processor exposes a galaxie API. Maps and score payloads are in memory,
without durable storage or eviction; restart-surviving feedback is unmeasured.

The host score client sends an array to `/api/public/scores`, with an ID formed
from trace ID and score name and an explicit timestamp. It stores the entire
first payload and resends its bytes, including the original value, name and
timestamp. Only transport errors and 5xx get bounded retries; 207 and 4xx do not.
The running Langfuse reference's description specifies 202/207, while its
generated response schema lists 200; live accepted posts return 202. Readback
uses `/api/public/v3/scores?fields=subject` with a five-minute polling window.
The fresh-date measurement first proves with a second score of another ID that
duplicate rows are visible to this readback, then resends the same ID with a
later-day payload, settles for 30 seconds and records the same-ID rows. Linking means the score's subject matches the
oracle trace and its observations are found; UI linking is unmeasured.
Credential-scan assertions escape the score client's transport retry loop. A
regression supplies a contaminated first response followed by a clean response
and requires the first scan to fail immediately, with no retry.

The Node runner invokes `uv run --locked --offline python -I evaluate.py` in the
spike's own Python project. The child receives only PATH, HOME, TMPDIR and three
client telemetry/hint controls; macOS also supplies `__CF_USER_TEXT_ENCODING`.
No Langfuse setting is passed. `MLFLOW_DISABLE_TELEMETRY=true`, `DO_NOT_TRACK=1`
and `MLFLOW_DISABLE_AGENT_HINT=1` apply to this new client surface. Complete
stdout and stderr are scanned before JSON parsing or error reporting. The script
searches by session and calls `mlflow.genai.evaluate` with `chat_usage_total`,
`chat_text_present` and `root_io_present`, using no model-based scorer or provider
key. Evaluation writes runs and assessments to the local experiment. Its returned
dataframe uses `trace_id`; an initial harness assumption of `request_id` failed
after evaluation and was corrected without changing any scorer assertion.

Empty root request/response is the sole framework follow-up. Chat-span text is
present with opt-in, but `invoke_agent` has no input/output attributes. The proposed
fix is a framework-neutral root-I/O contract under the existing text, label and
destination rules, requiring a contract decision. It is not implemented here.
Langfuse child-session grouping needs no framework change because the host
processor recipe works. MLflow's experiment search currently emits a deprecation
warning for `experiment_ids`; the pinned call still works.

The browser uses the existing strict `connect-src 'self'` policy and exports
through the same-origin collector proxy. Its `/feedback/scores` endpoint holds
the Langfuse key on the server and accepts one score name, finite values from zero
to one, an integer segment and bounded content-free IDs. A harness-issued
HttpOnly, SameSite=Strict cookie selects the user. The endpoint confirms the
reported trace's own run metadata and segment, then binds run/segment/trace to
that user. A flush only hands spans to the collector: pages must retry
`404 not-confirmed` after backend ingestion, and the live harness waits for roots
before reporting. No user comes from the body.

First-report-wins is only as strong as the secrecy of run and trace IDs: someone
who learns them first can bind them. Host-side hardening would bind at run start
through a host-issued grant. Browser telemetry is client-controlled; backend
confirmation establishes consistency, not authenticity. Cookies and bindings are
an in-memory fixture, not a real authentication design.

This run used Node 24.15.0, pnpm 11.21.0, OpenTelemetry API 1.10.0, SDK 3.1.0,
OTLP/HTTP exporter 0.301.0, Vite 8.3.4 and playwright-core 1.64.1 with headless
Chromium 156.0.8078.4 (shell revision 1248). Backends were rechecked as Langfuse
4.80.0, MLflow 3.18.0 and collector 0.154.0. Python is 3.14.6 and uv 0.11.23;
`mlflow`, `mlflow-skinny` and `mlflow-tracing` lock to 3.18.0 with
`requires-python = ">=3.14,<3.15"` and the absolute
`exclude-newer = "2026-11-08T00:00:00Z"` cutoff. npm dependencies are unchanged.

Langfuse and MLflow vendor telemetry stays at defaults by maintainer decision.
Galaxie trace data and opted-in text go only to the local backends. The credential
canary reaches only the local scripted provider and is absent from page traffic,
score responses and stored trace readbacks. Backend vendor telemetry payloads and
all container egress are unmeasured.

[feedback-verification.json](results/feedback-verification.json) records commands,
outcomes, hashes, the corrected harness failure and teardown. Existing Node
results and browser span results remain byte-identical. The only older browser
result change is five asset-name strings in `browser-evidence.json`, now written
as `assets/index-<hash>.js` because the new passive map and page reporting API
change the bundle.

Not measured in this feedback cycle: other executors; real models, real prompts
or answer quality; delivery guarantees, capacity or sustained operation; Langfuse
and MLflow web UI session views; model-based evaluation; real user authentication
or durable binding; score-read latency beyond the five-minute window; vendor
telemetry payloads and all container egress. No production deployment is evaluated.
