# ADK recipe attribution

Upstream: [google/adk-recipes](https://github.com/google/adk-recipes), commit `1e5ed1a5713b739ff8ba58b39454c02bf8bad118`. galaxie is not affiliated with or endorsed by Google. Upstream describes the recipes as not officially supported.

The repository root `LICENSE` is Apache License 2.0, compatible with galaxie's Apache-2.0 license. The read-only local clone was inspected for licenses, copyright headers and disclaimer notices on 2026-11-05; the TypeScript financial advisor's prompts and agent structure were also read for the rewrite. No files were written there. No separate `LICENSE` or `NOTICE` was found in the directories below. All inspected Python, TypeScript and Go source files in these directories carry the Apache-2.0 notice; no headerless source was reused.

| Recipe | Upstream directory | Source notices | Use |
| --- | --- | --- | --- |
| Financial advisor | `contrib/typescript/financial-advisor` | Copyright 2026 Google LLC | `app/agent.ts`, `app/prompt.ts` and the four `app/sub_agents/*/agent.ts` files inform `src/recipes/financial/agent.ts`; the four `app/sub_agents/*/prompt.ts` files are condensed in `src/recipes/financial/prompts.ts`. The verbatim `app/disclaimer.ts` text stays in `src/host/disclaimer.ts` and is re-exported by `src/recipes/financial/disclaimer.ts` |
| Financial advisor | `contrib/python/financial-advisor` | Copyright 2025 Google LLC; some files Copyright 2026 Google LLC | Provenance reference; no Python agent copied |
| Financial advisor | `contrib/go/financial-advisor` | Copyright 2026 Google LLC | Provenance reference; no Go agent copied |
| LLM auditor | `contrib/python/llm-auditor` | Copyright 2025 Google LLC; some tests Copyright 2026 Google LLC | Provenance reference; no agent or callbacks copied |
| Small-business loan | `contrib/python/small-business-loan-agent` | Copyright 2026 Google LLC | Provenance reference, including `app/sub_agents/pricing/tools.py`; its implementation was not read or copied. Host pricing uses documented synthetic tiers |
| Safety plugins | `core/python/safety-plugins` | Copyright 2025 Google LLC; some tests Copyright 2026 Google LLC | Notice review only; deliberately not rewritten |

Every file derived from a recipe names its upstream source and this commit, keeps that source's complete Apache notice below galaxie's SPDX header, and states its changes. Files without a notice must not be copied. Deployment files, cloud configuration and upstream dependency locks are not vendored. The financial mock replies and tests are authored for galaxie.

The changed disclaimer module adds galaxie's SPDX header and a provenance/change notice; the disclaimer text itself is unchanged. It is rendered as text by the host. Its references to Google are retained upstream wording, not a claim of endorsement.

## Financial advisor rewrite deltas

The ADK JavaScript rewrite uses a `SequentialAgent` of data, trading, execution and risk analysts instead of the conversational coordinator and its `AgentTool` specialists, which the adapter refuses. It retains each specialist's upstream name and `outputKey`; downstream prompts interpolate those state keys. One initial prompt supplies the ticker or invented company, risk attitude, investment period and execution preferences, replacing the coordinator's per-step questions.

Google Search becomes the host's bounded `market.search@1` fixture capability. Results remain untrusted tool output. The prompts retain the upstream report stages and disclaimer but are condensed for invented evidence: empty or unsupported findings are unverifiable, and actionable recommendations are withheld. Live-news freshness targets, SEC lookups, real prices and minimum search-result counts are dropped because the fixture corpus cannot substantiate them. The prompts also drop the fixed per-strategy field names, the "at least five strategies" floor when evidence is thin, the analysts' own introductions and the risk analyst's overall qualitative level and concluding trade-off section, and the upstream check for missing market data becomes an unverifiable-section rule. The cloud model, environment setup, `App`, deployment configuration and coordinator introduction are omitted because galaxie's host owns models and execution; the page already displays the disclaimer. No trade-execution capability is added.

Node and headless Chromium checks use scripted mock replies through the real adapter, router and broker. The injected-result canary demonstrates the fixed scripted tool sequence and offered-tool scope; it does not measure a model's resistance to prompt injection or financial answer quality. The recipe is available for integration and tests; the page's recipe picker and run UI are deferred.

All market bulletins, companies, applicants and business records in this host are invented fixtures. There is no real news or real personal data. Outputs are not financial advice and must not be used for real lending decisions. See [ADR-0025](../../docs/adr/0025-adk-recipes-demo.md) and [the example guide](README.md).
