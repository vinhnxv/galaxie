# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

"""Delegation spike: fixed outcome rule, recorded before running probes.

Green tests pin observations; only the satisfaction conditions below decide outcomes.
An unmeasured P0 makes the affected gap undetermined. P1 is informational.

Gap 1 (plain delegation): P0 D1-D5, G1, G2. Supported requires all satisfied
for plain/usage with unchanged shipped source. Alternative requires D3 and all
D1-D5/G1/G2 satisfied by helper or flattening, after a plain/usage D2/D4/D5
failure; helper must fit one Python function without a core export/bridge change.
Refused if D3 fails or no variant satisfies D1-D5. Failed G1 caps a successful
helper at alternative by documentation; otherwise refused with no guard available.
Gap 2 (child pauses): P0 P1-P4. Supported requires no unapproved gated bodies
(P1/P2), and hoist completion/restore (P3/P4) in both applicable lanes.
Alternative requires P1/P2 and CPython P3, a Node P3/P4 failure, and passing
flatten probe F1 in both lanes. Otherwise refused. Any P1/P2 unapproved body
means unsafe as shipped and is reported first.
Gap 3 (subgraphs/paths): P0 S1. Supported only with stable child stream paths
and supported Gap 2; otherwise refused. Alternative never applies.

ID priority lanes satisfaction condition
D1 P0 N model/token/tool totals count parent plus child exactly once
D2 P0 C,N total bridged requests never exceed parent step limit
D3 P0 N private child data blocks forbidden destination before provider
D4 P0 C stable child scopes across runs, disjoint from parent scopes
D5 P0 N one write overall and identical effect ID after restore
D6 P1 C each native child starts repairAttempt at zero
D7 P1 N child deltas are checked and projected to host streams
D8 P1 C non-GalaxieModel child requests are visible to bridge
P1 P0 C excluded DeferredToolRequests never executes gated body
P2 P0 C,N returned deferral data never executes gated body
P3 P0 C,N hoisted approval completes child, gated body once
P4 P0 N restored hoist preserves pending interaction and writes once
P5 P1 C record parallel pending interactions
P6 P1 C extra answer fields and tampered child metadata are rejected
S1 P0 N child delta events carry a stable path across identical runs
S2 P1 C prepared executor reports subgraphs false
G1 P0 C public signals distinguish nested runs without top-level false positives
G2 P0 C,N guard raises unsupported before nested bridge model request
F1 P0 C,N conditional pause alternative: flattened gate pauses/resumes/writes once

No private pydantic-ai imports: unavailable public guard signals are a documented
limit, not permission to import internals. Re-run on every pydantic-ai bump.
"""

from pydantic_ai import Agent

from galaxie.pydantic_ai import Executor, GalaxieModel


def factory(name: str = 'smoke', variant: str = 'usage') -> Executor:
    if name != 'smoke':
        raise ValueError('Unknown delegation probe.')
    return Executor(Agent(GalaxieModel('answer')))
