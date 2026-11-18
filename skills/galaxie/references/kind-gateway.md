# Gateway projects

<!-- galaxie:cite path="templates/kinds/gateway/files/README.md" heading="Routing, prompts and credentials" sha256="c253a5af55275270afb60cf1a4530af90c15b9cdf63a022538633b6daf55451a" -->
<!-- galaxie:summary:start -->
Keep upstream keys and private system prompts on the gateway. The page uses a
short-lived demo bearer and a host-server route; replace demo identity/session
issuance before real users. A third-party upstream requires destination and
consent review even behind a proxy. The default MemorySaver loses runs on reload.
<!-- galaxie:summary:end -->

<!-- galaxie:cite path="templates/kinds/gateway/files/README.md" heading="Limits and verification" sha256="4da6aa9ebaf70813b5ed458453dd17af22d5bcb50a5f40416cc8a57fc696fbe8" -->
The demo session endpoint and in-memory stores are not production authentication
or storage. Supply authenticated sessions, backend authorization, durable
transactional receipts, retention, cross-process quotas and provider billing
limits. Call quotas and token caps do not establish a spending limit. Preserve
CSP/Trusted Types. Dev/preview mocks prove wiring only; production remains
unavailable without an upstream. Retain the generated check's assertions.

Read the generated README and framework reference for build prerequisites. See
the [gateway starter](https://github.com/vinhnxv/galaxie/blob/main/templates/kinds/gateway/files/README.md).
