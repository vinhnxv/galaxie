# ADK recipe attribution

Upstream: [google/adk-recipes](https://github.com/google/adk-recipes), commit `1e5ed1a5713b739ff8ba58b39454c02bf8bad118`. galaxie is not affiliated with or endorsed by Google. Upstream describes the recipes as not officially supported.

The repository root `LICENSE` is Apache License 2.0, compatible with galaxie's Apache-2.0 license. The read-only local clone was inspected for licenses, copyright headers and disclaimer notices only on 2026-11-05. No files were written there. No separate `LICENSE` or `NOTICE` was found in the directories below. All inspected Python, TypeScript and Go source files in these directories carry the Apache-2.0 notice; no headerless source was reused.

| Recipe | Upstream directory | Source notices | Use |
| --- | --- | --- | --- |
| Financial advisor | `contrib/typescript/financial-advisor` | Copyright 2026 Google LLC | The disclaimer from `app/disclaimer.ts` is retained verbatim in `src/host/disclaimer.ts`; future agent rewrites are not included yet |
| Financial advisor | `contrib/python/financial-advisor` | Copyright 2025 Google LLC; some files Copyright 2026 Google LLC | Provenance reference; no Python agent copied |
| Financial advisor | `contrib/go/financial-advisor` | Copyright 2026 Google LLC | Provenance reference; no Go agent copied |
| LLM auditor | `contrib/python/llm-auditor` | Copyright 2025 Google LLC; some tests Copyright 2026 Google LLC | Provenance reference; no agent or callbacks copied |
| Small-business loan | `contrib/python/small-business-loan-agent` | Copyright 2026 Google LLC | Provenance reference, including `app/sub_agents/pricing/tools.py`; its implementation was not read or copied. Host pricing uses documented synthetic tiers |
| Safety plugins | `core/python/safety-plugins` | Copyright 2025 Google LLC; some tests Copyright 2026 Google LLC | Notice review only; deliberately not rewritten |

Every future file derived from a recipe must name its upstream source and this commit, keep that source's complete Apache notice below galaxie's SPDX header, and state its changes. Files without a notice must not be copied. Deployment files, cloud configuration and upstream dependency locks are not vendored.

The changed disclaimer module adds galaxie's SPDX header and a provenance/change notice; the disclaimer text itself is unchanged. It is rendered as text by the host. Its references to Google are retained upstream wording, not a claim of endorsement.

All market bulletins, companies, applicants and business records in this host are invented fixtures. There is no real news or real personal data. Outputs are not financial advice and must not be used for real lending decisions. See [ADR-0025](../../docs/adr/0025-adk-recipes-demo.md) and [the example guide](README.md).
