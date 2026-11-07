// SPDX-FileCopyrightText: 2026 Nguyễn Xuân Vĩnh
// SPDX-License-Identifier: Apache-2.0

/**
 * A model-chosen tool call may run a write only behind a host confirmation. Conformance fixtures
 * that reach a write through a tool helper bind it with `approval: 'confirm'`, pass these options
 * to `runtime.create` and approve each confirmation as it appears, so the run itself is unchanged.
 */
export function confirmationsFor(
  capabilities: readonly `${string}@${number}`[],
  revision: string,
): { capabilities: readonly `${string}@${number}`[]; policyRevision: () => string } {
  return { capabilities, policyRevision: () => revision };
}

interface Confirming {
  getSnapshot(): { readonly confirmations?: readonly { readonly id: string }[] };
  respond(id: string, action: 'approve'): unknown;
}

/** Approves every pending confirmation of an instance. The returned function stops it. */
export function autoApprove(instance: Confirming): () => void {
  const timer = setInterval(() => {
    for (const pending of instance.getSnapshot().confirmations ?? [])
      instance.respond(pending.id, 'approve');
  }, 5);
  return () => clearInterval(timer);
}
