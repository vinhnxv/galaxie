# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0
"""Pinned native-tool probes, with the outcome rule fixed before measurement.

Each cell is one native-tool kind in gap 1, or all of dynamic tools (gap 2)
or response parts (gap 3). Results are satisfied, not satisfied, or unmeasured.
Supported requires all four: a repository provider executes the kind; the
bridge accepts its declaration and result; a router feature names the kind;
and a probe proves broker grants, labels, budgets and confirmation apply.
Alternative requires failed support, a retrieval kind (web_search, web_fetch,
x_search, file_search, mcp_server), and satisfied N4. Otherwise refused requires
N2 or the gap's equivalent: fixed unsupported and zero model, capability and
interaction requests. A P0 bypass is unsafe as shipped; an unmeasured P0 makes
its cell undetermined. Informational observations never establish support.

Probe | Satisfied when (C = CPython, N = Node Pyodide, B = bridge)
N1 C,N | Static native kinds refuse at both prepare entries, zero requests.
N2 C,N | Requests refuse unsupported before any bridge request.
N3 C   | Default-native adaptive capabilities satisfy N1.
N4 C,N | Ordinary and explicit local search have equal transcripts, exactly
         one model request with one function declaration and no extra option,
         one capability call and pydantic-ai/<conversation>/<n>/<n> scope.
N5 C   | Informational: local fallback with native default is refused.
N6 C,N | Baseline, ordinary and capability tools prepare and run.
N7 C   | Informational: deferred loading refuses at request, zero requests.
D1 C,N | Native factories refuse at prepare or request, zero requests.
D2 C   | Override refuses unsupported, zero requests.
D3 C   | Direct request/stream, including optional tools, refuse, zero requests.
D4 C   | Informational: fixed first/resumed agent.run keyword names.
RP1 C  | Four native history parts refuse unsupported, zero requests.
RP2 C  | Extra reply key, non-function call, undeclared name refuse invalid.
B1 B   | Native/builtin options and non-function declarations refuse invalid.
B2 B   | Extra response part key refuses invalid.
RP3 N  | Array provider content refuses unsupported before Python reply;
         exactly one model call and zero capability calls.
RP4 N  | Informational, reasoned only: internal provider tools returning text
         cannot be observed by the adapter.

The exact one-model-request criterion in N4 remains fixed even if an ordinary
function-tool round trip needs more requests. Pin observations, then apply the
rule literally; do not change criteria to fit measurements.
"""
