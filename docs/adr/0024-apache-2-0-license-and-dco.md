# ADR-0024: License: Apache-2.0, with the Developer Certificate of Origin

- **Status:** Accepted (maintainer decision, 2026-11-04). It supersedes [ADR-0015](0015-licensing-agpl-with-commercial-license.md) entirely.
- **Date:** 2026-11-04
- **Revisions:**
  - 2026-11-04: the maintainer decided to publish galaxie without monetization, and chose Apache-2.0 over MIT.
- **Related:** brief §16.9; framework overview §5.3, §7, §8; ADR-0015

This ADR records an engineering and project position. It is not legal advice.

## Context

Maintainer decision (2026-11-04): galaxie is published for community adoption and is not monetized. The dual-license model of ADR-0015 (AGPL-3.0 plus a paid commercial license) existed to fund the project. Without it, the AGPL only slows adoption: many companies forbid AGPL dependencies by policy, and ADR-0015 itself names that effect as its sales mechanism.

Facts that shape the choice:

- **The maintainer is the sole copyright holder so far.** Every file carries the header `SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh`, and `AGENTS.md` has not accepted outside code (it waits for a CLA, ADR-0015). Because no other person holds rights in the tree, the maintainer can relicense it without anyone's consent. This stops being true when the first outside contribution is merged, which is why the relicense lands before the repository opens to contributions.
- **A relicense of the tree is mechanical but wide.** It touches every header, package field and license statement. It happens in one pull request, after this ADR, so the tree never mixes licenses (plan unit U2).
- **A CLA only matters for dual licensing.** The CLA of ADR-0015 existed so the maintainer could also sell the contributions commercially. With a single permissive license it adds friction for first contributors and a service to run, and gives nothing in return.
- **galaxie is a library embedded in host apps and loaded by agent frameworks.** Its dependencies are MIT (LangGraph.js, LangChain.js, MCP TypeScript SDK, React) and Apache-2.0 (WebLLM, Transformers.js). Apache-2.0 matches them, and its explicit patent grant and patent-termination clause cover the contributions to a project that routes between models and tools.
- **Model weights have their own licenses** and are not part of galaxie. Hosts must check them.

## Decision

- **License:** the whole repository is licensed under **Apache-2.0**: code, examples, templates, packages, documentation and ADRs. The earlier split (AGPL-3.0-only for code, CC BY-SA 4.0 for docs) ends.
  - Each source file starts with an SPDX header:
    ```ts
    // SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
    // SPDX-License-Identifier: Apache-2.0
    ```
  - Each `package.json` and `pyproject.toml` sets `license` to `Apache-2.0`.
  - The repository has a [`LICENSE`](../../LICENSE) file with the verbatim Apache-2.0 text.
  - The repository has a `NOTICE` file with the copyright line from the header. Distributions of the packages keep it, as Apache-2.0 section 4(d) requires.
- **No commercial license.** The commercial offer is withdrawn and `COMMERCIAL-LICENSE.md` is removed in plan unit U2. Nothing in this ADR rules out later services, support or sponsorship; they are not licensing decisions.
- **Contributions:** outside contributions are accepted under the **Developer Certificate of Origin** (DCO 1.1, <https://developercertificate.org/>). Each commit carries a `Signed-off-by` line that matches its author, made with `git commit -s`. A CI job checks every commit in a pull request. Contributions are licensed to the project under Apache-2.0 (section 5 of the license). No CLA is required.
- **Dependency license allowlist:** kept from ADR-0015. CI fails when a runtime dependency of a launch package has a license that is not on a reviewed allowlist of permissive identifiers, apart from explicit per-package exceptions with a recorded reason (plan unit U3).
- **SBOM:** ADR-0015 promised license data in an SBOM. That promise is deferred: the allowlist check covers the license part now, and an SBOM is follow-up work.
- **Trademark:** the name "galaxie" is not licensed by Apache-2.0 (section 6). The maintainer may publish a trademark policy later; this ADR does not.
- **Transition.** This ADR is Accepted when it merges. The tree stays AGPL-3.0-only until plan unit U2 merges, and new files keep the AGPL header until then. `AGENTS.md` keeps refusing outside code until the DCO check from plan unit U4 is active.

## Alternatives considered

- **MIT.** Simpler and shorter. Rejected: it has no express patent grant, and the dependencies galaxie wraps most closely (WebLLM, Transformers.js) are Apache-2.0.
- **Keep AGPL-3.0 without the commercial license.** Rejected: it keeps the adoption barrier of ADR-0015 and buys nothing without the paid tier.
- **Keep AGPL-3.0 with the commercial license (ADR-0015).** Rejected by the maintainer's decision to publish without monetization.
- **Keep a CLA.** Rejected: it served dual licensing only.
- **Apache-2.0 with the Commons Clause, BSL or the Functional Source License.** Rejected: they restrict use, are not open source, and conflict with the goal of adoption.
- **A field-of-use restriction** for high-risk sectors. Not possible under an open source license. Risk from such uses is handled by the Apache-2.0 disclaimer of warranty and limitation of liability (sections 7 and 8) and by the intended-use notice in the README.

## Consequences

- galaxie is OSI open source under a permissive license. Closed-source use is allowed.
- The maintainer gives up the option to sell a commercial license for the code written so far. Rights already granted under the AGPL to anyone who received the code before the relicense are not withdrawn; the AGPL text stays in the git history.
- ADR-0015 is kept for history. Its link to `COMMERCIAL-LICENSE.md` becomes plain text because the file is removed.
- A license change is one pull request over the whole tree (plan unit U2). Until it merges, statements that say AGPL are still true of the tree, and statements that say Apache-2.0 describe the decision.
- The lawyer review deferred by ADR-0015 for the CLA, the commercial agreement and section 7 terms is no longer needed. The legal review of learner data (`galaxie-f0k`) is unaffected and still gates making the repository public.
- Coding assistants copy code freely. `AGENTS.md`, `llms.txt` and the README state the license and the DCO rule in plain words once U2 and U7 land.

## Verification

- This ADR is Accepted by the maintainer's decision of 2026-11-04.
- ADR-0015 shows "Superseded by ADR-0024", and the ADR index lists 0024.
- Plan unit U2 verifies the tree: no `LICENSE`, package or pyproject license field, SPDX header or README license statement says AGPL, and `check:license` enforces Apache-2.0 headers.
- Plan unit U3 verifies the dependency allowlist in CI.
- Plan unit U4 verifies the DCO check on pull requests.
