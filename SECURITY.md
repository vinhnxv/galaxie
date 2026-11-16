# Vulnerability reporting

## Report privately

Use GitHub private vulnerability reporting for this repository: open the
repository's **Security** tab and select **Report a vulnerability**. Do not open a
public issue or pull request for a vulnerability.

Include:

- The affected package and version or commit.
- Steps to reproduce, with a minimal example when possible.
- The impact and which documented control is affected.

Reports are handled on a best-effort basis by a single maintainer. There are no
response-time promises.

## Supported versions

The project is pre-release. Only the `main` branch is supported; there are no
release branches yet.

## Scope

In scope are the packages `@galaxie-ai/ui-protocol`, `@galaxie-ai/core`, `@galaxie-ai/adapter-kit`,
`@galaxie-ai/adapter-langgraph`, `@galaxie-ai/models`, `@galaxie-ai/storage-indexeddb` and
`@galaxie-ai/react` (the seven launch packages), plus `@galaxie-ai/adapter-pyodide`,
`@galaxie-ai/adapter-adk`, `@galaxie-ai/adapter-go`, `@galaxie-ai/starter-go`,
`@galaxie-ai/starter-python` and `@galaxie-ai/create` in this repository, and their
documented controls. The seven launch packages are published to npm at 0.1.0.
All thirteen are prepared for the 0.2.0 lockstep release; 0.2.0 is not yet published.

Out of scope:

- Host application code and bindings.
- Trusted agent code that bypasses the router, as described in
  [ADR-0002](docs/adr/0002-trusted-first-execution.md).
- Example hosts and demo backends.
- Spikes.
- Vulnerabilities in third-party dependencies; report those upstream.
- Model answer quality or the prompt-injection robustness of a model itself.

## Controls and limits

The [security baseline](docs/adr/0012-security-baseline.md),
[security review](docs/security-review.md) and
[unsupported-features list](docs/unsupported.md) describe the controls and their
limits. galaxie gives no guarantee of security. Page code can read credentials
it is handed, including through XSS or a malicious same-origin dependency, as
described in ADR-0012.
