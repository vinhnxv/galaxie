# SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
# SPDX-License-Identifier: Apache-2.0

from interrupt_resume import INPUT, RESUMES, SCRIPT, create_graph


def factory(checkpointer, model=None, capability=None, interaction=None):
    return create_graph(checkpointer, interaction, "sync")
