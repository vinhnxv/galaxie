# Local trace sinks

This isolated demonstration sends one hand-made, two-span OTLP trace to a host
collector, then reads it from local Langfuse and MLflow APIs. Vendor attribute
mapping belongs to the collector. No galaxie runtime or package is changed.

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
data only to the local backends. This run sends only synthetic spans, with no
prompt text. Vendor telemetry payloads and all container egress were not measured.

## Workspace and verification

This workspace stays outside root CI. Its lock was seeded from
`../langgraph-nodeinterrupt-pause-time/pnpm-lock.yaml`, then regenerated once
after adding dependencies; frozen installation passes. It uses `link:` dependencies
on built galaxie packages, including the private ADK, Pyodide and Go adapters.
The full root build is required because the guard checks every public built export,
including the models package's subpaths.

Vite aliases and `resolve.dedupe` pin OpenTelemetry API, LangChain core and
LangGraph to the spike's copies. The runner test resolves each applicable module
from each linked built export and compares paths with the runner's path. Only
packages that do not declare a dependency or peer on a module skip that module.
The counterexample disables the aliases and exposes the second OpenTelemetry API
path reached from linked core. Plain Node resolution outside this runner is not
covered.

`pnpm test` runs offline guards and explicitly skips the live suite. `pnpm run
smoke` enables it with `LLMOPS_STACK=1`; an unreachable stack then fails. The
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

Not measured: galaxie runs, executor coverage, browser export, workflows, real
models, real prompts, feedback scores, MLflow evaluation, capacity, performance,
long-running ingestion or failure recovery. This is a local development
demonstration, not a deployment recommendation.
