# ADR-0015: License: AGPL-3.0 with a commercial license

- **Status:** Accepted (founder decision, 2026-10-28). The lawyer review is deferred; Verification lists when each part of it is needed.
- **Date:** 2026-10-28
- **Revisions:**
  - 2026-10-28: the founder chose AGPL-3.0-only with a commercial license. Commercial use is allowed when the user complies with the AGPL. Closed-source use requires a commercial license, obtained by contacting the copyright holder.
  - 2026-10-28: copyright holder recorded (Nguyễn Xuân Vĩnh, an individual); the founder deferred the lawyer review.
  - 2026-10-28: commercial tier options removed; they are business decisions outside this ADR.
- **Related:** brief §16.9; framework overview §5.3, §7, §8

This ADR records an engineering and product position. It is not legal advice.

## Context

Founder requirements (2026-10-28):

1. Non-commercial use is free.
2. Commercial use needs a paid license from the copyright holder. Copying for commercial purposes without a license is not allowed.
   - Clarified the same day: commercial use is fine when the product's source is public. The paid license is for businesses that want to keep their product closed.
3. Anyone may fork and modify the code.
4. Modified versions must keep their source code public, for security review among other reasons.
5. No company may turn the project, or a fork of it, into closed source.

Facts that shape the choice:

- **No standard, widely used software license meets both 1–2 and 4–5.**
  - Non-commercial licenses do not require modified versions to share their source. Examples are PolyForm Noncommercial 1.0.0 and Prosperity.
  - Copyleft licenses (AGPL-3.0, GPL-3.0) require source to be shared, but they allow commercial use. The Open Source Definition forbids restricting fields of use.
  - CC BY-NC-SA 4.0 combines "non-commercial" and "share-alike", but Creative Commons recommends against using its licenses for software: they have no patent terms and no notion of source code.
- **Dual licensing only works if the project holds the rights to every line.**
  - Every contributor must sign a contributor license agreement (CLA) that lets the project also license their contribution commercially.
  - A Developer Certificate of Origin (DCO) is not enough.
- **Galaxie is a library embedded into host apps.** Under AGPL-3.0, a host app that includes galaxie and is offered to users over a network must provide its corresponding source under the AGPL. A company that does not want this buys the commercial license. This is the model used by many dual-licensed projects.
- **No license can force a private, internal copy to be published to the whole world.** The AGPL requires source for everyone who receives the software or uses it over a network, which covers public web apps.
- **Dependencies are compatible.**
  - LangGraph.js, LangChain.js, the MCP TypeScript SDK and React are MIT.
  - WebLLM and Transformers.js are Apache-2.0.
  - All of them are compatible with AGPL-3.0 and with a commercial license, and their notices must be kept.
  - Model weights have their own licenses and are not part of galaxie.

## Decision

The founder accepts the AGPL trade-off. Commercial use is fine when the product's source is released under the AGPL. Businesses that want to keep their product closed pay for a commercial license.

- **Code:** every package and example is licensed under **AGPL-3.0-only**.
  - Each source file starts with an SPDX header:
    ```ts
    // SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
    // SPDX-License-Identifier: AGPL-3.0-only
    ```
  - Each `package.json` sets `"license": "AGPL-3.0-only"`.
  - The repository has a [`LICENSE`](../../LICENSE) file with the verbatim text from the Free Software Foundation (gnu.org, SHA-256 `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`).
- **Commercial license:** the copyright holder, Nguyễn Xuân Vĩnh (an individual), sells a commercial license for use in closed-source or proprietary products, without AGPL obligations.
  - [`COMMERCIAL-LICENSE.md`](../../COMMERCIAL-LICENSE.md) explains who needs one and how to contact the copyright holder.
  - The agreement itself (pricing, tiers, support, warranty, governing law) is drafted with a lawyer.
- **Contributions:** a CLA is required before any external contribution is merged, and it is enforced by a CLA check in CI.
  - The CLA lets the copyright holder relicense contributions commercially, and lets those rights pass to a successor, such as a company formed later.
  - Until the CLA is reviewed and published, external contributions are not merged.
- **Docs and ADRs:** CC BY-SA 4.0.
- **Trademark:** register the name "galaxie" and its logo. A trademark policy lets forks exist but not use the name for their product. This protects users from look-alike closed forks; the license protects the code.

## Alternatives considered

- **PolyForm Noncommercial 1.0.0 plus a commercial license.**
  - It blocks all commercial use, even by companies that would publish their source.
  - Forks do not have to publish source, so requirements 4 and 5 are not met.
  - It is not open source, which slows enterprise and security review.
  - It is the choice if blocking commercial use matters more than keeping forks public.
- **A custom "non-commercial share-alike" software license.** It would meet every requirement literally, but it must be written by a lawyer and is untested. Contributors, package registries and enterprise legal teams review unfamiliar licenses slowly, if at all.
- **CC BY-NC-SA 4.0 for code.** Rejected: not designed for software, as Creative Commons itself advises.
- **Apache-2.0 (earlier recommendation).** Rejected by the founder's requirements: it allows closed-source commercial forks.
- **Business Source License 1.1 or the Functional Source License.** Rejected: they restrict some commercial uses for a period and then convert to an open license, but they do not require forks to publish source.

## Consequences

- Galaxie is OSI open source under the AGPL. Hobby, education and open-source projects use it free; closed products buy a license.
- Many companies forbid AGPL dependencies by policy. That is the intended reason to buy, and it also slows adoption by developers at those companies. Mitigations are business decisions, outside this ADR.
- It reverses the earlier Apache-2.0 recommendation in the framework overview and the brief.
- The copyright holder is an individual. If a company later sells the commercial license, the copyright and the CLA rights must first be transferred to it in writing.
- Coding assistants copy code freely. `AGENTS.md`, `llms.txt` and the README state the license and what it means for closed apps, in plain words.
- CI checks:
  - SPDX headers and package license fields;
  - a dependency license allowlist, rejecting licenses incompatible with AGPL-3.0 or with commercial relicensing;
  - license data in the SBOM.

## Verification

- Done (2026-10-28): the founder chose AGPL-3.0-only with a commercial license.
- Done (2026-10-28): the copyright holder and the contact address are recorded in `COMMERCIAL-LICENSE.md`.
- Lawyer review: a human task, deferred by the founder on 2026-10-28. Publishing the code under the AGPL does not depend on it. Each part is needed before its first use:
  - the CLA, before the first external contribution is merged;
  - the commercial agreement, before the first commercial license is signed;
  - the trademark policy, before it is published.
- The CLA check is active before the first external contribution is merged.
- CI license checks are green before the first release.
